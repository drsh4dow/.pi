/**
 * Pure reading of `strace -ff -y` output for `untouched.ts`: what a traced process tree changed and connected to, and
 * whether any of it is the human's. With `-y`, strace prints the folder behind `AT_FDCWD` or a dir fd and the file an
 * opened fd resolved to, so an `*at` call and a write through a link resolve exactly. A relative path in a plain call
 * such as `mkdir` would need each process's cwd; it stays unresolved, and the check refuses to vouch. Any other named
 * path is as the call spelled it, so `untouched.ts` resolves its links on disk, and a link the run made and removed
 * counts as a write at the place it pointed to.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";

/** One traced call that succeeded and matters to the verdict. */
export type Traced =
	/** Changed the file at `path`, an absolute path. */
	| { readonly kind: "write"; readonly call: string; readonly path: string }
	/** Changed a file named relative to a cwd strace did not print. */
	| { readonly kind: "unresolved"; readonly call: string; readonly path: string }
	| { readonly kind: "connect"; readonly socket: string };

/** Where a call names a file it changes: the path argument, and the dir fd argument it is relative to, if any. */
interface Target {
	readonly dir?: number;
	readonly path?: number;
}

const one = (path: number, dir?: number): ReadonlyArray<Target> => [dir === undefined ? { path } : { dir, path }];

/** A call that changes the file an fd argument names. */
const fd = (dir: number): ReadonlyArray<Target> => [{ dir }];

/** The calls that change files, by the files they change. `open`, `openat` and `creat` also need a write flag. */
const targets = new Map([
	["open", one(0)],
	["openat", one(1, 0)],
	["openat2", one(1, 0)],
	["creat", one(0)],
	["mknod", one(0)],
	["mknodat", one(1, 0)],
	["mkdir", one(0)],
	["mkdirat", one(1, 0)],
	["rmdir", one(0)],
	["unlink", one(0)],
	["unlinkat", one(1, 0)],
	["rename", [...one(0), ...one(1)]],
	["renameat", [...one(1, 0), ...one(3, 2)]],
	["renameat2", [...one(1, 0), ...one(3, 2)]],
	["link", one(1)],
	["linkat", one(3, 2)],
	["symlink", one(1)],
	["symlinkat", one(2, 1)],
	["truncate", one(0)],
	["ftruncate", fd(0)],
	["fallocate", fd(0)],
	["chmod", one(0)],
	["fchmod", fd(0)],
	["fchmodat", one(1, 0)],
	["fchmodat2", one(1, 0)],
	["chown", one(0)],
	["lchown", one(0)],
	["fchown", fd(0)],
	["fchownat", one(1, 0)],
	["utime", one(0)],
	["utimes", one(0)],
	["futimesat", one(1, 0)],
	["utimensat", one(1, 0)],
	["setxattr", one(0)],
	["lsetxattr", one(0)],
	["fsetxattr", fd(0)],
	["removexattr", one(0)],
	["lremovexattr", one(0)],
	["fremovexattr", fd(0)],
]);

/** The `-e trace=` list. */
export const traced: ReadonlyArray<string> = [...targets.keys(), "connect"];

const opens = new Set(["open", "openat", "openat2", "creat"]);

const links = new Set(["symlink", "symlinkat"]);

const writeFlag = /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)\b/u;

const groupOf = (pattern: RegExp, name: string) => (text: string) =>
	Option.fromNullishOr(pattern.exec(text)?.groups?.[name]);

/** One argument: strings, `<...>` fd paths and `{...}` or `[...]` groups whole, so their commas do not split it. */
const argument = /(?:"(?:[^"\\]|\\.)*"(?:\.\.\.)?|<[^>]*>|\{[^}]*\}|\[[^\]]*\]|[^,])+/gu;

const escape = /\\(?:(?<octal>[0-7]{1,3})|x(?<hex>[0-9a-f]{2})|(?<char>.))|(?<plain>[^\\]+)/giu;

const controls = new Map([
	["n", "\n"],
	["t", "\t"],
	["r", "\r"],
	["v", "\v"],
	["f", "\f"],
]);

const utf8 = new TextEncoder();

const bytesOf = ({ octal, hex, char, plain }: Readonly<Record<string, string | undefined>>): ReadonlyArray<number> => {
	if (octal !== undefined) {
		return [Number.parseInt(octal, 8)];
	}

	if (hex !== undefined) {
		return [Number.parseInt(hex, 16)];
	}

	const text = char === undefined ? (plain ?? "") : (controls.get(char) ?? char);

	return [...utf8.encode(text)];
};

/** Pure. A path as strace prints it, its C escapes (`\303\251` for `é`) turned back into the bytes they stand for. */
const unescaped = (text: string) => {
	const tokens = Arr.fromIterable(Str.matchAll(escape)(text));
	const bytes = Arr.flatMap(tokens, ({ groups }) => bytesOf(groups ?? {}));

	return new TextDecoder().decode(Uint8Array.from(bytes));
};

/** The path in a `"..."` argument, unescaped; none for `NULL`. */
const stringOf = (arg: string) => Option.map(groupOf(/^"(?<text>(?:[^"\\]|\\.)*)"$/u, "text")(arg), unescaped);

/** The folder in `AT_FDCWD</cwd>` or `3</dir>`. */
const fdPathOf = (arg: string) => Option.map(groupOf(/<(?<path>[^>]*)>$/u, "path")(arg), unescaped);

const socketOf = groupOf(/sun_path="(?<socket>[^"]*)"/u, "socket");

/** Pure. Drops `.` and empty segments and applies `..`, so a prefix check cannot be walked around. */
const normalized = (path: string) => {
	const segments = Arr.reduce(Str.split(path, "/"), Arr.empty<string>(), (kept, segment) => {
		if (segment === "" || segment === ".") {
			return kept;
		}

		return segment === ".." ? Arr.dropRight(kept, 1) : [...kept, segment];
	});

	return `/${Arr.join(segments, "/")}`;
};

/** A call that returned without an error, with `-y`'s path of a returned fd. Failed calls return `-1 E...`. */
interface Call {
	readonly name: string;
	readonly args: ReadonlyArray<string>;
	readonly fdPath: Option.Option<string>;
	readonly line: string;
}

const succeeded = /^(?<name>\w+)\((?<args>.*)\) += [^-\s][^<\s]*(?:<(?<fdPath>[^>]*)>)?$/u;

const callIn = (line: string): Option.Option<Call> =>
	Option.map(Option.fromNullishOr(succeeded.exec(line)?.groups), (groups) => ({
		name: groups["name"] ?? "",
		args: Arr.map(Arr.fromIterable(Str.matchAll(argument)(groups["args"] ?? "")), ([arg]) => Str.trim(arg)),
		fdPath: Option.map(Option.fromNullishOr(groups["fdPath"]), unescaped),
		line,
	}));

const changed = (call: Call, target: Target): Option.Option<Traced> => {
	const dir = Option.fromUndefinedOr(target.dir).pipe(
		Option.flatMap((index) => Arr.get(call.args, index)),
		Option.flatMap(fdPathOf),
	);

	const path = Option.flatMap(
		Option.flatMap(Option.fromUndefinedOr(target.path), (index) => Arr.get(call.args, index)),
		stringOf,
	);

	const write = (at: string): Traced => ({ kind: "write", call: call.name, path: normalized(at) });

	if (Option.isNone(path)) {
		return Option.map(dir, write);
	}

	if (Str.startsWith("/")(path.value)) {
		return Option.some(write(path.value));
	}

	return Option.some(
		Option.match(dir, {
			onSome: (folder) => write(`${folder}/${path.value}`),
			onNone: () => ({ kind: "unresolved", call: call.name, path: path.value }),
		}),
	);
};

/** Pure. Where a new link points, resolved against the link's folder, as a write there by the call that made it. */
const pointedTo = (call: Call, made: ReadonlyArray<Traced>): ReadonlyArray<Traced> =>
	Arr.flatMap(made, (link) => {
		const target = Option.flatMap(Arr.get(call.args, 0), stringOf);

		if (link.kind !== "write" || Option.isNone(target)) {
			return [];
		}

		const at = Str.startsWith("/")(target.value) ? target.value : `${link.path}/../${target.value}`;

		return [{ kind: "write", call: call.name, path: normalized(at) }];
	});

/** Pure. What one traced call changed or connected to. An open counts once, at the file its fd resolved to. */
const tracedBy = (call: Call): ReadonlyArray<Traced> => {
	if (call.name === "connect") {
		return Arr.get(call.args, 1).pipe(
			Option.flatMap(socketOf),
			Option.map((socket): Traced => ({ kind: "connect", socket })),
			Option.toArray,
		);
	}

	const named = () => Arr.getSomes(Arr.map(targets.get(call.name) ?? [], (target) => changed(call, target)));

	if (links.has(call.name)) {
		return [...named(), ...pointedTo(call, named())];
	}

	if (!opens.has(call.name)) {
		return named();
	}

	if (call.name !== "creat" && !writeFlag.test(call.line)) {
		return [];
	}

	return Option.match(call.fdPath, {
		onSome: (path): ReadonlyArray<Traced> => [{ kind: "write", call: call.name, path }],
		onNone: named,
	});
};

/** Pure. Every traced call that succeeded and changed a file or connected to a socket, from every process's trace file. */
export const writesIn = (traces: ReadonlyArray<string>): ReadonlyArray<Traced> =>
	Arr.flatMap(traces, (text) => {
		const calls = Arr.getSomes(Arr.map(Str.split(text, "\n"), callIn));

		return Arr.flatMap(calls, tracedBy);
	});

export interface Verdict {
	/** Writes under `~/.pi/` or `~/.local/state/` other than pi's `auth.json` lock, and connects to another core. */
	readonly violations: ReadonlyArray<Traced>;
	/**
	 * The run's link to the human's `auth.json`, pi's lock on it, and a token refresh written through it. Reported, never
	 * failing.
	 */
	readonly sanctioned: ReadonlyArray<Traced>;
	/** Writes the trace cannot place. Any of these means the check cannot vouch. */
	readonly unresolved: ReadonlyArray<Traced>;
	/** The run's session files no traced write produced: a process outside the trace wrote for the run. */
	readonly missed: ReadonlyArray<string>;
}

/** Pure. The rules of `judge` for one human and one run. */
const rulesOf = ({ home, coreSession }: { readonly home: string; readonly coreSession: string }) => {
	const auth = `${home}/.pi/agent/auth.json`;

	return {
		isProtected: (path: string) =>
			Str.startsWith(`${home}/.pi/`)(`${path}/`) || Str.startsWith(`${home}/.local/state/`)(`${path}/`),
		isSanctioned: (path: string) => path === auth || path === `${auth}.lock` || Str.startsWith(`${auth}.lock/`)(path),
		isForeignCore: (socket: string) =>
			Str.includes("/herdr-core/")(socket) && !Str.startsWith(`${coreSession}.`)(Str.replace(/^.*\//u, "")(socket)),
	};
};

/**
 * Pure. Judges a run's traced calls. `coreSession` is the run's own terminal core; a connect to any other herdr-core
 * socket is how a run would show up in the human's terminal list.
 */
export const judge = (input: {
	readonly traced: ReadonlyArray<Traced>;
	readonly home: string;
	readonly coreSession: string;
	readonly runSessionFiles: ReadonlyArray<string>;
}): Verdict => {
	const rules = rulesOf(input);
	const writes = Arr.filter(input.traced, (each) => each.kind === "write");
	const written = new Set(Arr.map(writes, (write) => write.path));

	const isViolation = (each: Traced) =>
		each.kind === "connect"
			? rules.isForeignCore(each.socket)
			: each.kind === "write" && rules.isProtected(each.path) && !rules.isSanctioned(each.path);

	return {
		violations: Arr.filter(input.traced, isViolation),
		sanctioned: Arr.filter(writes, (write) => rules.isSanctioned(write.path)),
		unresolved: Arr.filter(input.traced, (each) => each.kind === "unresolved"),
		missed: Arr.filter(input.runSessionFiles, (file) => !written.has(file)),
	};
};
