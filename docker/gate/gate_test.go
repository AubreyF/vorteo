package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// syncBuffer collects audit lines written from server goroutines.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.buf.Write(p)
}

func (s *syncBuffer) entries(t *testing.T) []Entry {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	var entries []Entry
	for _, line := range strings.Split(strings.TrimSpace(s.buf.String()), "\n") {
		if line == "" {
			continue
		}
		var entry Entry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("audit line %q: %v", line, err)
		}
		entries = append(entries, entry)
	}
	return entries
}

// testGate treats loopback as the environment's subnet. allowLoopback lets
// tests reach local upstreams that production policy refuses.
func testGate(t *testing.T, policy string, allowLoopback bool) (*Gate, *syncBuffer, *httptest.Server) {
	t.Helper()
	sink := &syncBuffer{}
	gate, err := newGate(Config{
		Policy:       policy,
		Allow:        []string{"allowed.example"},
		Environments: []Environment{{Name: "dev", Generation: "g1", Subnet: "127.0.0.0/8"}},
	}, sink)
	if err != nil {
		t.Fatal(err)
	}
	if allowLoopback {
		gate.refused = mustPrefixes("100.64.0.0/10", "192.168.0.0/16")
	}
	server := httptest.NewServer(gate)
	t.Cleanup(server.Close)
	return gate, sink, server
}

func timeAfter() <-chan time.Time { return time.After(10 * time.Millisecond) }

func waitForEntries(t *testing.T, sink *syncBuffer, n int) []Entry {
	t.Helper()
	for i := 0; i < 200; i++ {
		if entries := sink.entries(t); len(entries) >= n {
			return entries
		}
		<-timeAfter()
	}
	t.Fatalf("expected %d audit entries, got %v", n, sink.entries(t))
	return nil
}

func TestRefusedRanges(t *testing.T) {
	gate, _, _ := testGate(t, "standard", false)
	for _, address := range []string{
		"127.0.0.1", "10.1.2.3", "100.92.236.9", "100.100.100.100", "169.254.169.254",
		"172.22.0.1", "192.168.65.254", "192.168.1.1", "::1", "fd7a:115c:a1e0::1",
		"fe80::1", "::ffff:10.0.0.1",
	} {
		if gate.refusedRule(netip.MustParseAddr(address)) == "" {
			t.Errorf("%s should be refused", address)
		}
	}
	for _, address := range []string{"1.1.1.1", "140.82.112.3", "2606:4700::1111"} {
		if rule := gate.refusedRule(netip.MustParseAddr(address)); rule != "" {
			t.Errorf("%s should be allowed, got %s", address, rule)
		}
	}
}

func connectThrough(t *testing.T, proxy, target string) (*http.Response, net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(proxy, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	if _, err := io.WriteString(conn, "CONNECT "+target+" HTTP/1.1\r\nHost: "+target+"\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	return response, conn, reader
}

func TestUnknownSourceIsRefused(t *testing.T) {
	gate, sink, server := testGate(t, "standard", true)
	gate.environments[0].prefix = netip.MustParsePrefix("10.99.0.0/16")
	response, _, _ := connectThrough(t, server.URL, "example.com:443")
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", response.StatusCode)
	}
	entry := waitForEntries(t, sink, 1)[0]
	if entry.Environment != "unknown" || entry.Decision != "deny" {
		t.Fatalf("entry %+v", entry)
	}
}

func TestConnectTunnelsAndRecords(t *testing.T) {
	_, sink, server := testGate(t, "standard", true)
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		conn, err := echo.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		buffer := make([]byte, 4)
		if _, err := io.ReadFull(conn, buffer); err == nil {
			conn.Write(buffer)
		}
	}()
	response, conn, reader := connectThrough(t, server.URL, echo.Addr().String())
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status %d", response.StatusCode)
	}
	io.WriteString(conn, "ping")
	reply := make([]byte, 4)
	if _, err := io.ReadFull(reader, reply); err != nil || string(reply) != "ping" {
		t.Fatalf("reply %q %v", reply, err)
	}
	conn.Close()
	entry := waitForEntries(t, sink, 1)[0]
	if entry.Decision != "allow" || entry.Environment != "dev" || entry.Generation != "g1" ||
		entry.BytesUp != 4 || entry.BytesDown != 4 || entry.Address != echo.Addr().String() {
		t.Fatalf("entry %+v", entry)
	}
}

func TestConnectToLoopbackIsRefused(t *testing.T) {
	_, sink, server := testGate(t, "standard", false)
	response, _, _ := connectThrough(t, server.URL, "127.0.0.1:6770")
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", response.StatusCode)
	}
	entry := waitForEntries(t, sink, 1)[0]
	if entry.Decision != "deny" || entry.Rule != "refused 127.0.0.0/8" || entry.Port != 6770 {
		t.Fatalf("entry %+v", entry)
	}
}

func TestRebindingToTailnetIsRefused(t *testing.T) {
	gate, sink, server := testGate(t, "standard", false)
	gate.resolver = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("100.100.100.100")}, nil
	}
	response, _, _ := connectThrough(t, server.URL, "public-looking.example:443")
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", response.StatusCode)
	}
	if entry := waitForEntries(t, sink, 1)[0]; entry.Rule != "refused 100.64.0.0/10" {
		t.Fatalf("entry %+v", entry)
	}
}

func TestForwardStripsProxyCredentialsAndLabelsAgent(t *testing.T) {
	_, sink, server := testGate(t, "standard", true)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Proxy-Authorization") != "" {
			t.Error("proxy credentials reached upstream")
		}
		io.WriteString(w, "hello")
	}))
	defer upstream.Close()
	proxy, _ := url.Parse(server.URL)
	proxy.User = url.UserPassword("agent-7", "unused")
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
	response, err := client.Get(upstream.URL + "/path")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "hello" {
		t.Fatalf("body %q", body)
	}
	entry := waitForEntries(t, sink, 1)[0]
	if entry.Agent != "agent-7" || entry.Method != "GET" || entry.Status != 200 || entry.BytesDown != 5 {
		t.Fatalf("entry %+v", entry)
	}
}

func TestSealedPolicyRefusesUnlistedHosts(t *testing.T) {
	_, sink, server := testGate(t, "sealed", true)
	response, _, _ := connectThrough(t, server.URL, "unlisted.example:443")
	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d", response.StatusCode)
	}
	if entry := waitForEntries(t, sink, 1)[0]; entry.Rule != "sealed: host not allowed" {
		t.Fatalf("entry %+v", entry)
	}
}

func TestRouteAllowsOnlyItsExactHostAndPort(t *testing.T) {
	sink := &syncBuffer{}
	gate, err := newGate(Config{
		Policy:       "standard",
		Routes:       []string{"interface.example:443"},
		Environments: []Environment{{Name: "dev", Subnet: "127.0.0.0/8"}},
	}, sink)
	if err != nil {
		t.Fatal(err)
	}
	gate.resolver = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("100.114.176.2")}, nil
	}
	dialed := ""
	gate.dial = func(_ context.Context, _, address string) (net.Conn, error) {
		dialed = address
		client, server := net.Pipe()
		go server.Close()
		return client, nil
	}
	entry := Entry{}
	if _, err := gate.connect(context.Background(), "interface.example", 443, &entry); err != nil || dialed != "100.114.176.2:443" {
		t.Fatalf("route should connect: %v %q", err, dialed)
	}
	if entry.Rule != "route interface.example:443" {
		t.Fatalf("rule %q", entry.Rule)
	}
	for _, target := range []struct {
		host string
		port int
	}{{"interface.example", 22}, {"other.example", 443}} {
		entry := Entry{}
		if _, err := gate.connect(context.Background(), target.host, target.port, &entry); err != errRefused {
			t.Fatalf("%s:%d should be refused, got %v", target.host, target.port, err)
		}
	}
	if _, err := newGate(Config{Policy: "standard", Routes: []string{"100.64.0.1:443"},
		Environments: []Environment{{Name: "dev", Subnet: "127.0.0.0/8"}}}, sink); err == nil {
		t.Fatal("IP literal routes must be rejected")
	}
}

func TestRelayForwardsInbound(t *testing.T) {
	gate, sink, _ := testGate(t, "standard", false)
	daemon := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "daemon")
	}))
	defer daemon.Close()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go gate.relay(listener, Relay{Listen: listener.Addr().String(), Target: strings.TrimPrefix(daemon.URL, "http://"), Environment: "dev"})
	response, err := (&http.Client{Transport: &http.Transport{DisableKeepAlives: true}}).Get("http://" + listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "daemon" {
		t.Fatalf("body %q", body)
	}
	if entry := waitForEntries(t, sink, 1)[0]; entry.Direction != "in" || entry.Decision != "allow" {
		t.Fatalf("entry %+v", entry)
	}
}
