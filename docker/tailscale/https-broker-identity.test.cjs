const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "https_broker.py"), "utf8");
const code = source
  .split("    def daemon_identity(self):")[1]
  .split('code = r"""')[1]
  .split('"""')[0];
function fixture(managed = true) {
  const home = "/fixture/home",
    root = "/fixture/releases",
    release = root + "/selected";
  const entry = release + "/packages/server/dist/server/server/daemon-worker.js";
  const marker = { version: 1, pid: 100, root, link: root + "/current" };
  const status = (pid, parent, name = "node", uid = 1000) =>
    `Name:\t${name}\nPid:\t${pid}\nPPid:\t${parent}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
  const stat = (pid, ticks) =>
    `${pid} (name with spaces) ` + ["S", ...Array(18).fill("0"), ticks].join(" ");
  const files = {
    [home + "/paseo.pid"]: JSON.stringify({ pid: 100 }),
    "/proc/sys/kernel/random/boot_id": "boot-fixture\n",
    "/proc/100/status": status(100, 1, "Paseo Superviso"),
    "/proc/100/stat": stat(100, "1000"),
    "/proc/101/status": status(101, 100, managed ? "node" : "Paseo Daemon"),
    "/proc/101/stat": stat(101, "1001"),
    "/proc/101/cmdline": "/fixture/node\0" + entry + "\0",
    "/proc/100/environ": `PASEO_MANAGED_RELEASE_LINK=${marker.link}\0PASEO_MANAGED_RELEASE_ROOT=${root}\0`,
  };
  if (managed) files[home + "/managed-supervisor.json"] = JSON.stringify(marker);
  const links = {
    [root]: root,
    [marker.link]: release,
    [entry]: entry,
    "/proc/100/exe": "/fixture/node",
    "/proc/101/exe": "/fixture/node",
    "/fixture/node": "/fixture/node",
  };
  const f = {
    home,
    root,
    release,
    entry,
    marker,
    files,
    links,
    pids: ["100", "101"],
    status,
    stat,
    reads: {},
  };
  f.run = () => {
    let output = "";
    const read = (collection, key) => {
      if (!(key in collection)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      const value = collection[key];
      return typeof value === "function" ? value(++f.reads[key] || (f.reads[key] = 1)) : value;
    };
    const fake = {
      readFileSync: (k) => read(files, k),
      existsSync: (k) => k in files,
      realpathSync: (k) => read(links, k),
      readdirSync: (k) => {
        assert.equal(k, "/proc");
        return f.pids;
      },
    };
    vm.runInNewContext(code, {
      require: (name) => {
        if (name === "node:fs") return fake;
        if (name === "node:path") return path;
        assert.equal(name, "node:os");
        return { homedir: () => home };
      },
      process: {
        env: { PASEO_HOME: home },
        getuid: () => 1000,
        exit: () => {
          throw new Error("rejected");
        },
        stdout: { write: (v) => (output += v) },
      },
    });
    return output;
  };
  return f;
}
test("legacy child retains boot PID and start-time identity", () =>
  assert.equal(fixture(false).run(), "boot-fixture:101:1001"));
test("managed exact selected worker works without process title", () =>
  assert.equal(fixture().run(), "boot-fixture:101:1001"));
test("unmanaged node process is not a legacy daemon", () => {
  const f = fixture(false);
  f.files["/proc/101/status"] = f.status(101, 100);
  assert.throws(f.run);
});
for (const [name, change] of [
  ["different parent", (f) => (f.files["/proc/101/status"] = f.status(101, 99))],
  [
    "different worker owner",
    (f) => (f.files["/proc/101/status"] = f.status(101, 100, "node", 1001)),
  ],
  [
    "different supervisor owner",
    (f) => (f.files["/proc/100/status"] = f.status(100, 1, "Paseo Superviso", 1001)),
  ],
  [
    "different release argv",
    (f) => (f.files["/proc/101/cmdline"] = "/fixture/node\0/other/daemon-worker.js\0"),
  ],
  ["extra worker argument", (f) => (f.files["/proc/101/cmdline"] += "--extra\0")],
  ["different node executable", (f) => (f.links["/proc/101/exe"] = "/other/node")],
  [
    "different node argv",
    (f) => {
      f.files["/proc/101/cmdline"] = "/other/node\0" + f.entry + "\0";
      f.links["/other/node"] = "/other/node";
    },
  ],
  ["selected release escapes root", (f) => (f.links[f.marker.link] = "/other/release")],
  ["worker entry symlink", (f) => (f.links[f.entry] = "/other/worker")],
  ["supervisor environment mismatch", (f) => (f.files["/proc/100/environ"] = "unrelated")],
  [
    "marker PID mismatch",
    (f) =>
      (f.files[f.home + "/managed-supervisor.json"] = JSON.stringify({ ...f.marker, pid: 999 })),
  ],
  [
    "marker version mismatch",
    (f) =>
      (f.files[f.home + "/managed-supervisor.json"] = JSON.stringify({ ...f.marker, version: 2 })),
  ],
  [
    "marker link outside root",
    (f) =>
      (f.files[f.home + "/managed-supervisor.json"] = JSON.stringify({
        ...f.marker,
        link: "/other/current",
      })),
  ],
  [
    "invalid marker does not fall back to legacy",
    (f) => {
      f.files[f.home + "/managed-supervisor.json"] = "{}";
      f.files["/proc/101/status"] = f.status(101, 100, "Paseo Daemon");
    },
  ],
  [
    "ambiguous matches",
    (f) => {
      f.pids.push("102");
      for (const kind of ["status", "stat", "cmdline"])
        f.files["/proc/102/" + kind] = f.files["/proc/101/" + kind];
      f.links["/proc/102/exe"] = "/fixture/node";
    },
  ],
  [
    "owner record race",
    (f) => (f.files[f.home + "/paseo.pid"] = (n) => JSON.stringify({ pid: n === 1 ? 100 : 999 })),
  ],
  [
    "worker PID reuse",
    (f) => (f.files["/proc/101/stat"] = (n) => f.stat(101, n === 1 ? "1001" : "9999")),
  ],
  [
    "owner PID reuse",
    (f) => (f.files["/proc/100/stat"] = (n) => f.stat(100, n === 1 ? "1000" : "9999")),
  ],
  [
    "release selection race",
    (f) => (f.links[f.marker.link] = (n) => (n === 1 ? f.release : f.root + "/other")),
  ],
  [
    "boot identity race",
    (f) =>
      (f.files["/proc/sys/kernel/random/boot_id"] = (n) =>
        n === 1 ? "boot-fixture" : "another-boot"),
  ],
])
  test(name, () => {
    const f = fixture();
    change(f);
    assert.throws(f.run);
  });
test("unrelated same-name process does not compete with exact managed worker", () => {
  const f = fixture();
  f.pids.push("103");
  f.files["/proc/103/status"] = f.status(103, 88, "Paseo Daemon");
  assert.equal(f.run(), "boot-fixture:101:1001");
});
test("PID reuse during identity inspection is rejected", () => {
  const f = fixture();
  const original = f.files["/proc/101/status"];
  f.files["/proc/101/status"] = () => {
    f.files["/proc/101/stat"] = f.stat(101, "9999");
    return original;
  };
  assert.throws(f.run);
});
