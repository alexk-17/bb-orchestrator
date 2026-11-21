import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { profileName } from "./config.ts";

/** Credentials never enter settings, SQLite, CLI output or a process argument. */
export class Credentials {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  path(name: string) {
    return join(this.dir, `${profileName.parse(name)}.token`);
  }
  directory() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.dir);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.())
      throw new Error("Credential directory must be owned by the server user with mode 0700");
  }
  read(name: string) {
    this.directory();
    const fd = openSync(this.path(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.() || st.size > 16384)
        throw new Error("Credential file must be owned by the server user with mode 0600");
      return readFileSync(fd, "utf8").trim();
    } finally {
      closeSync(fd);
    }
  }
  write(name: string, token: string) {
    if (!/^xoxb-[A-Za-z0-9-]+$/.test(token) || token.length > 16384) throw new Error("Expected a Slack bot token on stdin");
    this.directory();
    const path = this.path(name),
      tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      try {
        writeFileSync(fd, token);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
}
