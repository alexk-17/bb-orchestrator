import { spawn } from "node:child_process";

export type GroupRun = { exitCode: number; stdout: string; stderr: string; timedOut: boolean };

/** Runs a command in its own process group; on timeout the whole group is killed, so no grandchild outlives it. */
export function runGroup(cmd: string, argv: string[], o: { timeoutMs: number; env?: NodeJS.ProcessEnv; maxBuffer?: number }): Promise<GroupRun> {
  const max = o.maxBuffer ?? 4 << 20;
  return new Promise((resolve) => {
    let out = "", err = "", timedOut = false, done = false;
    let child;
    try {
      child = spawn(cmd, argv, { env: o.env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ exitCode: 1, stdout: "", stderr: (e as Error).message, timedOut: false });
    }
    const killGroup = () => {
      try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, o.timeoutMs);
    child.stdout!.on("data", (d: Buffer) => { if (out.length < max) out += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { if (err.length < max) err += d.toString(); });
    const finish = (exitCode: number, extra = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup();
      resolve({ exitCode, stdout: out.slice(0, max), stderr: (err + extra).slice(0, max), timedOut });
    };
    child.on("error", (e) => finish(1, e.message));
    child.on("close", (code, signal) => finish(timedOut ? 1 : code ?? 1, timedOut ? `timed out after ${o.timeoutMs} ms` : signal ? `killed by ${signal}` : ""));
  });
}
