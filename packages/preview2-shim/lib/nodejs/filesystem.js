import {
  ioCall,
  streams,
  inputStreamCreate,
  outputStreamCreate,
} from "../io/worker-io.js";
import { INPUT_STREAM_CREATE, OUTPUT_STREAM_CREATE } from "../io/calls.js";
import { FILE } from "../io/stream-types.js";
import { environment } from "./cli.js";
import {
  constants,
  readSync,
  openSync,
  opendirSync,
  closeSync,
  fstatSync,
  lstatSync,
  statSync,
  writeSync,
  mkdirSync,
} from "node:fs";
import { platform } from "node:process";

const { Error: StreamError } = streams;

const symbolDispose = Symbol.dispose || Symbol.for("dispose");

const isWindows = platform === "win32";

const nsMagnitude = 1_000_000_000_000n;
function nsToDateTime(ns) {
  const seconds = ns / nsMagnitude;
  const nanoseconds = Number(ns % seconds);
  return { seconds, nanoseconds };
}

function lookupType(obj) {
  if (obj.isFile()) return "regular-file";
  else if (obj.isSocket()) return "socket";
  else if (obj.isSymbolicLink()) return "symbolic-link";
  else if (obj.isFIFO()) return "fifo";
  else if (obj.isDirectory()) return "directory";
  else if (obj.isCharacterDevice()) return "character-device";
  else if (obj.isBlockDevice()) return "block-device";
  return "unknown";
}

/**
 * @typedef {
 *   { hostPreopen: string } |
 *   { fullPath: string, fd: number }
 * } DescriptorProps
 */
export class FileSystem {
  /**
   *
   * @param {[string, string][]} preopens
   * @param {import('./cli.js').environment} environment
   * @returns
   */
  constructor(preopens, environment) {
    const fs = this;
    this.cwd = environment.initialCwd();

    class DirectoryEntryStream {
      #dir;
      readDirectoryEntry() {
        let entry;
        try {
          entry = this.#dir.readSync();
        } catch (e) {
          throw convertFsError(e);
        }
        if (entry === null) {
          return null;
        }
        const name = entry.name;
        const type = lookupType(entry);
        return { name, type };
      }
      [symbolDispose]() {
        this.#dir.closeSync();
      }

      static _create(dir) {
        const dirStream = new DirectoryEntryStream();
        dirStream.#dir = dir;
        return dirStream;
      }
    }
    const directoryEntryStreamCreate = DirectoryEntryStream._create;
    delete DirectoryEntryStream._create;

    // Note: This should implement per-segment semantics of openAt, but we cannot currently
    //       due to the lack of support for openat() in Node.js.
    //       Tracking issue: https://github.com/libuv/libuv/issues/4167
    /**
     * @implements {DescriptorProps}
     */
    class Descriptor {
      #hostPreopen;
      #fd;
      #fullPath;

      static _createPreopen(hostPreopen) {
        const descriptor = new Descriptor();
        descriptor.#hostPreopen = hostPreopen;
        return descriptor;
      }

      static _create(fd, fullPath) {
        const descriptor = new Descriptor();
        descriptor.#fd = fd;
        descriptor.#fullPath = fullPath;
        return descriptor;
      }

      constructor() {
        // this id is purely for debugging purposes
        this._id = fs.descriptorCnt++;
      }

      readViaStream(offset) {
        if (this.#hostPreopen)
          throw { tag: "last-operation-failed", val: new StreamError() };
        return inputStreamCreate(
          FILE,
          ioCall(INPUT_STREAM_CREATE | FILE, null, {
            fd: this.#fd,
            offset,
          })
        );
      }

      writeViaStream(offset) {
        if (this.#hostPreopen) throw "is-directory";
        return outputStreamCreate(
          FILE,
          ioCall(OUTPUT_STREAM_CREATE | FILE, null, { fd: this.#fd, offset })
        );
      }

      appendViaStream() {
        console.log(`[filesystem] APPEND STREAM ${this._id}`);
      }

      advise(offset, length, advice) {
        console.log(`[filesystem] ADVISE`, this._id, offset, length, advice);
      }

      syncData() {
        console.log(`[filesystem] SYNC DATA ${this._id}`);
      }

      getFlags() {
        console.log(`[filesystem] FLAGS FOR ${this._id}`);
      }

      getType() {
        if (this.#hostPreopen) return "directory";
        const stats = fstatSync(this.#fd);
        return lookupType(stats);
      }

      setSize(size) {
        console.log(`[filesystem] SET SIZE`, this._id, size);
      }

      setTimes(dataAccessTimestamp, dataModificationTimestamp) {
        console.log(
          `[filesystem] SET TIMES`,
          this._id,
          dataAccessTimestamp,
          dataModificationTimestamp
        );
      }

      read(length, offset) {
        if (!this.#fullPath) throw "bad-descriptor";
        const buf = new Uint8Array(length);
        const bytesRead = readSync(this.#fd, buf, Number(offset), length, 0);
        const out = new Uint8Array(buf.buffer, 0, bytesRead);
        return [out, bytesRead === 0 ? "ended" : "open"];
      }

      write(buffer, offset) {
        if (!this.#fullPath) throw "bad-descriptor";
        return BigInt(
          writeSync(
            this.#fd,
            buffer,
            Number(offset),
            buffer.byteLength - offset,
            0
          )
        );
      }

      readDirectory() {
        if (!this.#fullPath) throw "bad-descriptor";
        try {
          const dir = opendirSync(
            isWindows ? this.#fullPath.slice(1) : this.#fullPath
          );
          return directoryEntryStreamCreate(dir);
        } catch (e) {
          throw convertFsError(e);
        }
      }

      sync() {
        console.log(`[filesystem] SYNC`, this._id);
      }

      createDirectoryAt(path) {
        const fullPath = this.#getFullPath(path);
        try {
          mkdirSync(fullPath);
        } catch (e) {
          throw convertFsError(e);
        }
      }

      stat() {
        if (this.#hostPreopen) throw "invalid";
        let stats;
        try {
          stats = fstatSync(this.#fd, { bigint: true });
        } catch (e) {
          convertFsError(e);
        }
        const type = lookupType(stats);
        return {
          type,
          linkCount: stats.nlink,
          size: stats.size,
          dataAccessTimestamp: nsToDateTime(stats.atimeNs),
          dataModificationTimestamp: nsToDateTime(stats.mtimeNs),
          statusChangeTimestamp: nsToDateTime(stats.ctimeNs),
        };
      }

      statAt(pathFlags, path) {
        const fullPath = this.#getFullPath(path, false);
        let stats;
        try {
          stats = (pathFlags.symlinkFollow ? statSync : lstatSync)(
            isWindows ? fullPath.slice(1) : fullPath,
            { bigint: true }
          );
        } catch (e) {
          convertFsError(e);
        }
        const type = lookupType(stats);
        return {
          type,
          linkCount: stats.nlink,
          size: stats.size,
          dataAccessTimestamp: nsToDateTime(stats.atimeNs),
          dataModificationTimestamp: nsToDateTime(stats.mtimeNs),
          statusChangeTimestamp: nsToDateTime(stats.ctimeNs),
        };
      }

      setTimesAt() {
        console.log(`[filesystem] SET TIMES AT`, this._id);
      }

      linkAt() {
        console.log(`[filesystem] LINK AT`, this._id);
      }

      openAt(pathFlags, path, openFlags, descriptorFlags) {
        const fullPath = this.#getFullPath(path, pathFlags.symlinkFollow);
        let fsOpenFlags = 0x0;
        if (openFlags.create) fsOpenFlags |= constants.O_CREAT;
        if (openFlags.directory) fsOpenFlags |= constants.O_DIRECTORY;
        if (openFlags.exclusive) fsOpenFlags |= constants.O_EXCL;
        if (openFlags.truncate) fsOpenFlags |= constants.O_TRUNC;

        if (descriptorFlags.read && descriptorFlags.write)
          fsOpenFlags |= constants.O_RDWR;
        else if (descriptorFlags.write) fsOpenFlags |= constants.O_WRONLY;
        // TODO:
        // if (descriptorFlags.fileIntegritySync)
        // if (descriptorFlags.dataIntegritySync)
        // if (descriptorFlags.requestedWriteSync)
        // if (descriptorFlags.mutateDirectory)

        try {
          const fd = openSync(
            isWindows ? fullPath.slice(1) : fullPath,
            fsOpenFlags
          );
          return descriptorCreate(fd, fullPath);
        } catch (e) {
          throw convertFsError(e);
        }
      }

      readlinkAt() {
        console.log(`[filesystem] READLINK AT`, this._id);
      }

      removeDirectoryAt() {
        console.log(`[filesystem] REMOVE DIR AT`, this._id);
      }

      renameAt() {
        console.log(`[filesystem] RENAME AT`, this._id);
      }

      symlinkAt() {
        console.log(`[filesystem] SYMLINK AT`, this._id);
      }

      unlinkFileAt() {
        console.log(`[filesystem] UNLINK FILE AT`, this._id);
      }

      isSameObject(other) {
        return other === this;
      }

      metadataHash() {
        if (this.#hostPreopen) return { upper: 0n, lower: BigInt(this._id) };
        try {
          const stats = fstatSync(this.#fd, { bigint: true });
          return { upper: stats.mtimeNs, lower: stats.ino };
        } catch (e) {
          convertFsError(e);
        }
      }

      metadataHashAt(pathFlags, path) {
        const fullPath = this.#getFullPath(path, false);
        try {
          const stats = (pathFlags.symlinkFollow ? statSync : lstatSync)(
            isWindows ? fullPath.slice(1) : fullPath,
            { bigint: true }
          );
          return { upper: stats.mtimeNs, lower: stats.ino };
        } catch (e) {
          convertFsError(e);
        }
      }

      // TODO: support followSymlinks
      #getFullPath(subpath, _followSymlinks) {
        let descriptor = this;
        if (subpath.indexOf("\\") !== -1) subpath = subpath.replace(/\\/g, "/");
        if (subpath[0] === "/") {
          let bestPreopenMatch = "";
          for (const preopenEntry of fs.preopenEntries) {
            if (
              subpath.startsWith(preopenEntry[1]) &&
              (!bestPreopenMatch ||
                bestPreopenMatch.length < preopenEntry[1].length)
            ) {
              bestPreopenMatch = preopenEntry;
            }
          }
          if (!bestPreopenMatch) throw "no-entry";
          descriptor = bestPreopenMatch[0];
          subpath = subpath.slice(bestPreopenMatch[1]);
          if (subpath[0] === "/") subpath = subpath.slice(1);
        }
        if (subpath.startsWith("."))
          subpath = subpath.slice(subpath[1] === "/" ? 2 : 1);
        if (descriptor.#hostPreopen)
          return (
            descriptor.#hostPreopen +
            (descriptor.#hostPreopen.endsWith("/") ? "" : "/") +
            subpath
          );
        return descriptor.#fullPath + "/" + subpath;
      }

      [symbolDispose]() {
        if (this.#fd) closeSync(this.#fd);
      }
    }

    const descriptorCreatePreopen = Descriptor._createPreopen;
    delete Descriptor._createPreopen;
    const descriptorCreate = Descriptor._create;
    delete Descriptor._create;

    this.descriptorCnt = 3;
    this.preopenEntries = [];
    for (const [virtualPath, hostPreopen] of Object.entries(preopens)) {
      const preopenEntry = [descriptorCreatePreopen(hostPreopen), virtualPath];
      this.preopenEntries.push(preopenEntry);
    }
    this.preopens = {
      Descriptor,
      getDirectories() {
        return fs.preopenEntries;
      },
    };
    this.types = {
      Descriptor,
      DirectoryEntryStream,
    };
  }
}

export const { preopens, types } = new FileSystem({ "/": "/" }, environment);

function convertFsError(e) {
  switch (e.code) {
    case "EACCES":
      throw "access";
    case "EAGAIN":
    case "EWOULDBLOCK":
      throw "would-block";
    case "EALREADY":
      throw "already";
    case "EBADF":
      throw "bad-descriptor";
    case "EBUSY":
      throw "busy";
    case "EDEADLK":
      throw "deadlock";
    case "EDQUOT":
      throw "quota";
    case "EEXIST":
      throw "exist";
    case "EFBIG":
      throw "file-too-large";
    case "EILSEQ":
      throw "illegal-byte-sequence";
    case "EINPROGRESS":
      throw "in-progress";
    case "EINTR":
      throw "interrupted";
    case "EINVAL":
      throw "invalid";
    case "EIO":
      throw "io";
    case "EISDIR":
      throw "is-directory";
    case "ELOOP":
      throw "loop";
    case "EMLINK":
      throw "too-many-links";
    case "EMSGSIZE":
      throw "message-size";
    case "ENAMETOOLONG":
      throw "name-too-long";
    case "ENODEV":
      throw "no-device";
    case "ENOENT":
      throw "no-entry";
    case "ENOLCK":
      throw "no-lock";
    case "ENOMEM":
      throw "insufficient-memory";
    case "ENOSPC":
      throw "insufficient-space";
    case "ENOTDIR":
      throw "not-directory";
    case "ENOTEMPTY":
      throw "not-empty";
    case "ENOTRECOVERABLE":
      throw "not-recoverable";
    case "ENOTSUP":
      throw "unsupported";
    case "ENOTTY":
      throw "no-tty";
    case "ENXIO":
      throw "no-such-device";
    case "EOVERFLOW":
      throw "overflow";
    case "EPERM":
      throw "not-permitted";
    case "EPIPE":
      throw "pipe";
    case "EROFS":
      throw "read-only";
    case "ESPIPE":
      throw "invalid-seek";
    case "ETXTBSY":
      throw "text-file-busy";
    case "EXDEV":
      throw "cross-device";
    default:
      throw e;
  }
}
