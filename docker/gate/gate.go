// Command gate is the only network path in and out of Vorteo container
// environments. It proxies outbound connections after checking each resolved
// address against policy, relays inbound connections to environment daemons,
// and writes one JSON line per connection. See
// docs/plans/execution-environments/network-gate.md.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Config is read from a Host-owned file that no environment can write.
type Config struct {
	Log          string        `json:"log"`
	Proxy        string        `json:"proxy"`
	Environments []Environment `json:"environments"`
	Relays       []Relay       `json:"relays"`
	// Policy is "standard" (public internet minus refused ranges) or
	// "sealed" (only Allow).
	Policy string   `json:"policy"`
	Allow  []string `json:"allow,omitempty"`
	// Routes are exact host:port pairs that may resolve into refused ranges,
	// such as the installation's own interface on the tailnet. Each one is a
	// deliberate exception the Host configures; the service behind it still
	// authenticates every request.
	Routes []string `json:"routes,omitempty"`
}

// Environment maps a source subnet to an environment identity. Each
// environment has its own internal Docker network, so a guest cannot choose
// the subnet its connections arrive from.
type Environment struct {
	Name       string `json:"name"`
	Generation string `json:"generation"`
	Subnet     string `json:"subnet"`
	prefix     netip.Prefix
}

// Relay forwards inbound TCP from a published port to an environment daemon.
type Relay struct {
	Listen      string `json:"listen"`
	Target      string `json:"target"`
	Environment string `json:"environment"`
}

// refused lists destinations no environment may reach: the Host, the
// tailnet, local networks, link-local and metadata addresses.
var refused = mustPrefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
	"198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "64:ff9b:1::/48", "100::/64", "2001:db8::/32",
	"fc00::/7", "fe80::/10", "ff00::/8",
)

func mustPrefixes(values ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, len(values))
	for i, value := range values {
		prefixes[i] = netip.MustParsePrefix(value)
	}
	return prefixes
}

// Entry is one audit record. It never carries payloads, headers or
// credential values.
type Entry struct {
	Time        string `json:"time"`
	Direction   string `json:"direction"`
	Environment string `json:"environment"`
	Generation  string `json:"generation,omitempty"`
	Agent       string `json:"agent,omitempty"`
	Source      string `json:"source"`
	Method      string `json:"method,omitempty"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	Address     string `json:"address,omitempty"`
	Decision    string `json:"decision"`
	Rule        string `json:"rule,omitempty"`
	Status      int    `json:"status,omitempty"`
	BytesUp     int64  `json:"bytesUp"`
	BytesDown   int64  `json:"bytesDown"`
	DurationMs  int64  `json:"durationMs"`
	Error       string `json:"error,omitempty"`
}

// Gate holds the policy and audit sink.
type Gate struct {
	environments []Environment
	sealed       bool
	allow        map[string]bool
	routes       map[string]bool
	refused      []netip.Prefix
	resolver     func(ctx context.Context, host string) ([]netip.Addr, error)
	dial         func(ctx context.Context, network, address string) (net.Conn, error)
	mu           sync.Mutex
	sink         io.Writer
}

func newGate(config Config, sink io.Writer) (*Gate, error) {
	g := &Gate{
		sealed:  config.Policy == "sealed",
		allow:   map[string]bool{},
		routes:  map[string]bool{},
		refused: refused,
		sink:    sink,
		resolver: func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		},
		dial: (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
	}
	if config.Policy != "standard" && config.Policy != "sealed" {
		return nil, fmt.Errorf("policy must be standard or sealed, not %q", config.Policy)
	}
	for _, host := range config.Allow {
		g.allow[strings.ToLower(host)] = true
	}
	for _, route := range config.Routes {
		host, port, err := splitTarget(route, 0)
		if err != nil || net.ParseIP(host) != nil {
			return nil, fmt.Errorf("route %q must be hostname:port", route)
		}
		g.routes[strings.ToLower(host)+":"+strconv.Itoa(port)] = true
	}
	for _, environment := range config.Environments {
		prefix, err := netip.ParsePrefix(environment.Subnet)
		if err != nil || environment.Name == "" {
			return nil, fmt.Errorf("environment %q needs a name and a subnet", environment.Name)
		}
		environment.prefix = prefix.Masked()
		g.environments = append(g.environments, environment)
	}
	if len(g.environments) == 0 {
		return nil, errors.New("configure at least one environment")
	}
	return g, nil
}

func (g *Gate) record(entry Entry) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if err := json.NewEncoder(g.sink).Encode(entry); err != nil {
		log.Printf("audit write failed: %v", err)
	}
}

// identify returns the environment a connection came from, or false for a
// source outside every configured subnet.
func (g *Gate) identify(remote string) (Environment, bool) {
	address, err := netip.ParseAddrPort(remote)
	if err != nil {
		return Environment{}, false
	}
	for _, environment := range g.environments {
		if environment.prefix.Contains(address.Addr().Unmap()) {
			return environment, true
		}
	}
	return Environment{}, false
}

// refusedRule names the refused range containing address, if any.
func (g *Gate) refusedRule(address netip.Addr) string {
	address = address.Unmap()
	for _, prefix := range g.refused {
		if prefix.Contains(address) {
			return "refused " + prefix.String()
		}
	}
	return ""
}

// connect resolves host, refuses forbidden addresses and dials the first
// permitted one. Resolving here, not in the environment, defeats DNS
// rebinding: the address checked is the address dialed.
func (g *Gate) connect(ctx context.Context, host string, port int, entry *Entry) (net.Conn, error) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	route := g.routes[host+":"+strconv.Itoa(port)]
	if g.sealed && !g.allow[host] && !route {
		entry.Rule = "sealed: host not allowed"
		return nil, errRefused
	}
	var addresses []netip.Addr
	if literal, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		addresses = []netip.Addr{literal}
	} else {
		resolved, err := g.resolver(ctx, host)
		if err != nil {
			entry.Rule = "resolve failed"
			return nil, err
		}
		addresses = resolved
	}
	var last error = errRefused
	for _, address := range addresses {
		if rule := g.refusedRule(address); rule != "" && !route {
			entry.Rule = rule
			continue
		}
		target := netip.AddrPortFrom(address.Unmap(), uint16(port)).String()
		conn, err := g.dial(ctx, "tcp", target)
		if err == nil {
			entry.Address, entry.Rule = target, ""
			if route {
				entry.Rule = "route " + host + ":" + strconv.Itoa(port)
			}
			return conn, nil
		}
		entry.Address, last = target, err
	}
	return nil, last
}

var errRefused = errors.New("destination refused by gate policy")

// splitTarget parses host:port, defaulting the port for absolute-form HTTP.
func splitTarget(hostport string, defaultPort int) (string, int, error) {
	host, portText, err := net.SplitHostPort(hostport)
	if err != nil {
		if defaultPort == 0 {
			return "", 0, err
		}
		return hostport, defaultPort, nil
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return "", 0, fmt.Errorf("invalid port %q", portText)
	}
	return host, port, nil
}

// agentLabel reads attribution from Proxy-Authorization. It is a label the
// daemon supplies per agent, not proof: agents in one environment share
// authority.
func agentLabel(r *http.Request) string {
	value := r.Header.Get("Proxy-Authorization")
	encoded, ok := strings.CutPrefix(value, "Basic ")
	if !ok {
		return ""
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return ""
	}
	user, _, _ := strings.Cut(string(decoded), ":")
	if len(user) > 128 {
		user = user[:128]
	}
	return user
}

func (g *Gate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	environment, known := g.identify(r.RemoteAddr)
	entry := Entry{
		Time: start.UTC().Format(time.RFC3339Nano), Direction: "out", Source: r.RemoteAddr,
		Environment: environment.Name, Generation: environment.Generation,
		Agent: agentLabel(r), Method: r.Method,
	}
	defer func() {
		entry.DurationMs = time.Since(start).Milliseconds()
		g.record(entry)
	}()
	fail := func(status int, decision, message string) {
		entry.Decision, entry.Status = decision, status
		if entry.Error == "" {
			entry.Error = message
		}
		http.Error(w, "gate: "+message, status)
	}
	if !known {
		entry.Environment = "unknown"
		fail(http.StatusForbidden, "deny", "source is not a configured environment")
		return
	}
	if r.Method == http.MethodConnect {
		g.tunnel(w, r, &entry, fail)
		return
	}
	if !r.URL.IsAbs() || r.URL.Scheme != "http" {
		entry.Host = r.Host
		fail(http.StatusBadRequest, "deny", "send absolute http:// URLs or CONNECT to this proxy")
		return
	}
	g.forward(w, r, &entry, fail)
}

func (g *Gate) tunnel(w http.ResponseWriter, r *http.Request, entry *Entry, fail func(int, string, string)) {
	host, port, err := splitTarget(r.Host, 0)
	entry.Host, entry.Port = host, port
	if err != nil {
		fail(http.StatusBadRequest, "deny", "CONNECT needs host:port")
		return
	}
	upstream, err := g.connect(r.Context(), host, port, entry)
	if err != nil {
		g.refuse(err, entry, fail)
		return
	}
	defer upstream.Close()
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		fail(http.StatusInternalServerError, "error", "connection cannot be tunneled")
		return
	}
	client, buffered, err := hijacker.Hijack()
	if err != nil {
		entry.Decision, entry.Error = "error", err.Error()
		return
	}
	defer client.Close()
	entry.Decision, entry.Status = "allow", http.StatusOK
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
		entry.Error = err.Error()
		return
	}
	entry.BytesUp, entry.BytesDown = pipe(client, buffered.Reader, upstream)
}

// pipe copies both directions until both sides finish, returning the bytes
// sent upstream and downstream. source reads from the client; for a hijacked
// connection it is the buffered reader, which drains bytes already read
// before reading the connection itself.
func pipe(client net.Conn, source io.Reader, upstream net.Conn) (int64, int64) {
	var up, down atomic.Int64
	done := make(chan struct{}, 2)
	go func() {
		n, _ := io.Copy(upstream, source)
		up.Store(n)
		closeWrite(upstream)
		done <- struct{}{}
	}()
	go func() {
		n, _ := io.Copy(client, upstream)
		down.Store(n)
		closeWrite(client)
		done <- struct{}{}
	}()
	<-done
	<-done
	return up.Load(), down.Load()
}

func closeWrite(conn net.Conn) {
	if tcp, ok := conn.(interface{ CloseWrite() error }); ok {
		_ = tcp.CloseWrite()
	} else {
		_ = conn.Close()
	}
}

// hopHeaders are removed in both directions of a forwarded HTTP request.
var hopHeaders = []string{
	"Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
	"Proxy-Connection", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

func (g *Gate) forward(w http.ResponseWriter, r *http.Request, entry *Entry, fail func(int, string, string)) {
	host, port, err := splitTarget(r.URL.Host, 80)
	entry.Host, entry.Port = host, port
	if err != nil {
		fail(http.StatusBadRequest, "deny", "invalid destination")
		return
	}
	transport := &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return g.connect(ctx, host, port, entry)
		},
		ResponseHeaderTimeout: 60 * time.Second,
	}
	defer transport.CloseIdleConnections()
	outbound := r.Clone(r.Context())
	outbound.RequestURI = ""
	for _, name := range hopHeaders {
		outbound.Header.Del(name)
	}
	body := &countingReader{reader: r.Body}
	if r.Body != nil && r.Body != http.NoBody {
		outbound.Body = body
	}
	response, err := transport.RoundTrip(outbound)
	entry.BytesUp = body.count
	if err != nil {
		g.refuse(err, entry, fail)
		return
	}
	defer response.Body.Close()
	for _, name := range hopHeaders {
		response.Header.Del(name)
	}
	for name, values := range response.Header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	entry.Decision, entry.Status = "allow", response.StatusCode
	w.WriteHeader(response.StatusCode)
	entry.BytesDown, _ = io.Copy(w, response.Body)
}

func (g *Gate) refuse(err error, entry *Entry, fail func(int, string, string)) {
	if errors.Is(err, errRefused) {
		fail(http.StatusForbidden, "deny", entry.Rule)
		return
	}
	entry.Error = err.Error()
	fail(http.StatusBadGateway, "error", "upstream connection failed")
}

type countingReader struct {
	reader io.ReadCloser
	count  int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.reader.Read(p)
	c.count += int64(n)
	return n, err
}

func (c *countingReader) Close() error { return c.reader.Close() }

// relay accepts inbound TCP on a published port and forwards it to an
// environment daemon. Relay targets are configured by the Host, so they skip
// outbound policy.
func (g *Gate) relay(listener net.Listener, relay Relay) {
	for {
		client, err := listener.Accept()
		if err != nil {
			log.Printf("relay %s stopped: %v", relay.Listen, err)
			return
		}
		go g.relayOne(client, relay)
	}
}

func (g *Gate) relayOne(client net.Conn, relay Relay) {
	defer client.Close()
	start := time.Now()
	host, port, _ := splitTarget(relay.Target, 0)
	entry := Entry{
		Time: start.UTC().Format(time.RFC3339Nano), Direction: "in", Environment: relay.Environment,
		Source: client.RemoteAddr().String(), Host: host, Port: port,
	}
	defer func() {
		entry.DurationMs = time.Since(start).Milliseconds()
		g.record(entry)
	}()
	upstream, err := g.dial(context.Background(), "tcp", relay.Target)
	if err != nil {
		entry.Decision, entry.Error = "error", err.Error()
		return
	}
	defer upstream.Close()
	entry.Decision, entry.Address = "allow", upstream.RemoteAddr().String()
	entry.BytesUp, entry.BytesDown = pipe(client, client, upstream)
}

func main() {
	path := flag.String("config", "/etc/gate/config.json", "gate configuration")
	flag.Parse()
	data, err := os.ReadFile(*path)
	if err != nil {
		log.Fatal(err)
	}
	var config Config
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&config); err != nil {
		log.Fatalf("config: %v", err)
	}
	sink, err := os.OpenFile(config.Log, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		log.Fatal(err)
	}
	gate, err := newGate(config, sink)
	if err != nil {
		log.Fatal(err)
	}
	for _, relay := range config.Relays {
		listener, err := net.Listen("tcp", relay.Listen)
		if err != nil {
			log.Fatal(err)
		}
		go gate.relay(listener, relay)
	}
	server := &http.Server{
		Addr:              config.Proxy,
		Handler:           gate,
		ReadHeaderTimeout: 30 * time.Second,
		ErrorLog:          log.New(os.Stderr, "proxy: ", log.LstdFlags),
	}
	log.Printf("gate: proxy %s, %d relays, %s policy", config.Proxy, len(config.Relays), config.Policy)
	log.Fatal(server.ListenAndServe())
}
