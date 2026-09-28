import { constants, type Stats } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathWithin } from "./util.js";

export type SafeFileFailure =
  | "missing"
  | "outside"
  | "not-file"
  | "too-large"
  | "unreadable";

export class SafeFileError extends Error {
  constructor(readonly reason: SafeFileFailure) {
    super(reason);
  }
}

export interface SafeFileContents {
  contents: Buffer;
  information: Stats;
  path: string;
}

function mapFileError(error: unknown): SafeFileError {
  if (error instanceof SafeFileError) return error;
  return new SafeFileError(
    (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable",
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readAtMost(
  file: Awaited<ReturnType<typeof open>>,
  maxBytes: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await file.read(
      buffer,
      offset,
      buffer.byteLength - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new SafeFileError("too-large");
  return Buffer.from(buffer.subarray(0, offset));
}

/**
 * Opens and validates a file before reading from its descriptor. Rechecking the
 * opened file's identity closes the path-swap window between realpath and read.
 */
export async function readContainedFile(
  candidate: string,
  boundary: string,
  maxBytes: number,
): Promise<SafeFileContents> {
  const absolute = resolve(candidate);
  if (!isPathWithin(boundary, absolute)) {
    throw new SafeFileError("outside");
  }

  let initialPath: string;
  try {
    initialPath = await realpath(absolute);
  } catch (error) {
    throw mapFileError(error);
  }
  if (!isPathWithin(boundary, initialPath)) {
    throw new SafeFileError("outside");
  }

  let file;
  try {
    file = await open(
      initialPath,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    throw mapFileError(error);
  }

  try {
    const information = await file.stat();
    if (!information.isFile()) throw new SafeFileError("not-file");
    if (information.size > maxBytes) throw new SafeFileError("too-large");

    let confirmedPath: string;
    let confirmedInformation: Stats;
    try {
      confirmedPath = await realpath(initialPath);
      confirmedInformation = await stat(confirmedPath);
    } catch (error) {
      throw mapFileError(error);
    }
    if (!isPathWithin(boundary, confirmedPath)) {
      throw new SafeFileError("outside");
    }
    if (!sameFile(information, confirmedInformation)) {
      throw new SafeFileError("unreadable");
    }

    return {
      contents: await readAtMost(file, maxBytes),
      information,
      path: confirmedPath,
    };
  } catch (error) {
    throw mapFileError(error);
  } finally {
    await file.close();
  }
}
