import { expect, test } from "bun:test";

import * as Arr from "effect/Array";

import { judge, writesIn } from "./trace.ts";

const home = "/home/u";

const coreSession = "pi-driver-42-0abc12";

const run = "/tmp/pi-driver/leaf-wake-20260514-101010-42";

const session = `${run}/sessions/a.jsonl`;

const sessionWrite = `openat(AT_FDCWD</tmp/pi-driver/leaf-wake-20260514-101010-42/project>, "${session}", O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC, 0666) = 21<${session}>`;

const rows = [
	{
		name: "pi's lock on the human's auth.json is sanctioned",
		trace: [
			sessionWrite,
			`mkdir("${home}/.pi/agent/auth.json.lock", 0777) = 0`,
			`openat(AT_FDCWD</p>, "${run}/home/.pi/agent/auth.json", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0600) = 22<${home}/.pi/agent/auth.json>`,
			`rmdir("${home}/.pi/agent/auth.json.lock") = 0`,
		],
		expected: { violations: [], sanctioned: 3, unresolved: [], missed: [] },
	},
	{
		name: "a session file written in the human's own session folder is a violation",
		trace: [
			sessionWrite,
			`openat(AT_FDCWD</p>, "${home}/.pi/agent/sessions/--p--/b.jsonl", O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC, 0666) = 4<${home}/.pi/agent/sessions/--p--/b.jsonl>`,
		],
		expected: {
			violations: [{ kind: "write", call: "openat", path: `${home}/.pi/agent/sessions/--p--/b.jsonl` }],
			sanctioned: 0,
			unresolved: [],
			missed: [],
		},
	},
	{
		name: "openat2 and fd-only changes count at the file their fd names",
		trace: [
			sessionWrite,
			`openat2(AT_FDCWD</p>, "${home}/.pi/agent/settings.json", {flags=O_WRONLY|O_TRUNC, mode=0, resolve=0}, 24) = 3<${home}/.pi/agent/settings.json>`,
			`fchmod(4<${home}/.local/state/f>, 0600) = 0`,
			`ftruncate(5<${home}/.local/state/g>, 0) = 0`,
		],
		expected: {
			violations: [
				{ kind: "write", call: "openat2", path: `${home}/.pi/agent/settings.json` },
				{ kind: "write", call: "fchmod", path: `${home}/.local/state/f` },
				{ kind: "write", call: "ftruncate", path: `${home}/.local/state/g` },
			],
			sanctioned: 0,
			unresolved: [],
			missed: [],
		},
	},
	{
		name: "a link into the human's folders counts as a write where it points",
		trace: [
			sessionWrite,
			`symlink("${home}/.pi/agent", "${run}/alias") = 0`,
			`symlinkat("../.local/state", AT_FDCWD</p>, "${home}/.pi/s") = 0`,
		],
		expected: {
			violations: [
				{ kind: "write", call: "symlink", path: `${home}/.pi/agent` },
				{ kind: "write", call: "symlinkat", path: `${home}/.pi/s` },
				{ kind: "write", call: "symlinkat", path: `${home}/.local/state` },
			],
			sanctioned: 0,
			unresolved: [],
			missed: [],
		},
	},
	{
		name: "a relative write resolves through AT_FDCWD's folder",
		trace: [
			sessionWrite,
			`openat(AT_FDCWD<${home}/.local>, "state/x/../y/f", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 3<${home}/.local/state/y/f>`,
			`mkdirat(AT_FDCWD<${home}/.local>, "./state/z", 0777) = 0`,
		],
		expected: {
			violations: [
				{ kind: "write", call: "openat", path: `${home}/.local/state/y/f` },
				{ kind: "write", call: "mkdirat", path: `${home}/.local/state/z` },
			],
			sanctioned: 0,
			unresolved: [],
			missed: [],
		},
	},
	{
		name: "a relative path with no folder stays unresolved",
		trace: [sessionWrite, `mkdir("rel", 0777) = 0`, `rename("rel2", "${run}/rel3") = 0`],
		expected: {
			violations: [],
			sanctioned: 0,
			unresolved: [
				{ kind: "unresolved", call: "mkdir", path: "rel" },
				{ kind: "unresolved", call: "rename", path: "rel2" },
			],
			missed: [],
		},
	},
	{
		name: "a connect to another herdr-core socket is a violation, the run's own is not",
		trace: [
			sessionWrite,
			`connect(3<socket:[87004336]>, {sa_family=AF_UNIX, sun_path="/run/user/1000/herdr-core/default.sock"}, 41) = 0`,
			`connect(4<socket:[87004337]>, {sa_family=AF_UNIX, sun_path="/t/pi-driver/${coreSession}/herdr-core/${coreSession}.sock"}, 80) = 0`,
		],
		expected: {
			violations: [{ kind: "connect", socket: "/run/user/1000/herdr-core/default.sock" }],
			sanctioned: 0,
			unresolved: [],
			missed: [],
		},
	},
	{
		name: "a run session file no traced write produced is missed",
		trace: [`openat(AT_FDCWD</p>, "${session}", O_RDONLY|O_CLOEXEC) = 21<${session}>`],
		expected: { violations: [], sanctioned: 0, unresolved: [], missed: [session] },
	},
	{
		name: "failed calls and reads change nothing",
		trace: [
			sessionWrite,
			`openat(AT_FDCWD</p>, "${home}/.pi/agent/settings.json", O_RDONLY|O_CLOEXEC) = 5<${home}/.pi/agent/settings.json>`,
			`mkdir("${home}/.local/state/x", 0777) = -1 EEXIST (File exists)`,
			`unlinkat(AT_FDCWD</p>, "${home}/.pi/x", 0) = -1 ENOENT (No such file or directory)`,
		],
		expected: { violations: [], sanctioned: 0, unresolved: [], missed: [] },
	},
] as const;

for (const { name, trace, expected } of rows) {
	test(`writesIn and judge: ${name}`, () => {
		const verdict = judge({
			traced: writesIn([Arr.join(trace, "\n")]),
			home,
			coreSession,
			runSessionFiles: [session],
		});

		expect({ ...verdict, sanctioned: verdict.sanctioned.length }).toEqual(expected);
	});
}

test("a home with non-ASCII bytes matches the escaped paths strace prints", () => {
	const accented = "/home/ü";

	const verdict = judge({
		traced: writesIn([
			`openat(AT_FDCWD</p>, "/home/\\303\\274/.pi/agent/settings.json", O_WRONLY|O_TRUNC) = 3</home/\\303\\274/.pi/agent/settings.json>`,
			`mkdirat(AT_FDCWD</home/\\303\\274>, ".local/state/a\\"b", 0777) = 0`,
		]),
		home: accented,
		coreSession,
		runSessionFiles: [],
	});

	expect(verdict.violations).toEqual([
		{ kind: "write", call: "openat", path: `${accented}/.pi/agent/settings.json` },
		{ kind: "write", call: "mkdirat", path: `${accented}/.local/state/a"b` },
	]);
});
