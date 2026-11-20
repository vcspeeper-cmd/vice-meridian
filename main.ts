// VICE MERIDIAN — the hand-in program for this gta6-01 entry (Node 22+, standard library only).
// The game itself is the static site in game/ (index.html, the ES modules in game/src and the
// vendored three.js build in game/vendor); it needs no build step and makes no network request.
// This program validates game/ against entry limits, copies game/ and screenshots/ into the output
// directory (/output, or MAKEFUN_OUTPUT_DIR when set), writes dossier.json with the vendored
// make.fun library signatures and hashes, and prints a build summary with file counts and bytes.
//
// Play it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The entry root: everything below here is written relative to it, so the program behaves the same
// whatever directory it is launched from.
const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Limits this entry holds itself to. They sit inside the scorer's own caps (993 files, 48 MiB,
// 1000-byte paths), so a build that passes here is never refused later for size.
const MIN_GAME_FILES = 8;
const MAX_GAME_FILES = 900;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PATH_BYTES = 1000;

type Tally = { files: number; bytes: number };
type FileInfo = { path: string; bytes: number };

// Every regular file below `root`, depth first, with its size. Symlinks are listed as files with
// their own link size and never followed, so a stray link cannot pull in a tree from outside.
function listFiles(root: string): FileInfo[] {
  const found: FileInfo[] = [];
  const pending: string[] = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    // Sorted names keep the walk order stable, so reports and dossiers match between machines.
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = lstatSync(full);
      if (info.isDirectory()) pending.push(full);
      else found.push({ path: full, bytes: info.size });
    }
  }
  return found;
}

// The path as the scorer spells it: relative to the entry root with forward slashes, e.g.
// "game/src/main.js". Used for error reporting and dossier entries so paths match across systems.
function entryPath(full: string): string {
  return relative(here, full).split(sep).join('/');
}

// Total file count and byte size for a tree; zero/zero when the directory is absent.
function tally(root: string): Tally {
  if (!existsSync(root)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  for (const file of listFiles(root)) {
    files += 1;
    bytes += file.bytes;
  }
  return { files, bytes };
}

// Refuse to build an entry that breaks the limits above, naming the first offending path.
// Checks, in order: the game directory exists, index.html exists, the file count is in range,
// no path reaches the byte cap, and no file reaches the size cap.
function validate(): void {
  const gameDir = join(here, 'game');
  const indexHtml = join(gameDir, 'index.html');

  if (!existsSync(gameDir) || !lstatSync(gameDir).isDirectory()) {
    throw new Error(`validate: missing game directory: ${entryPath(gameDir)}`);
  }
  if (!existsSync(indexHtml) || !lstatSync(indexHtml).isFile()) {
    throw new Error(`validate: missing entry page: ${entryPath(indexHtml)}`);
  }

  const files = listFiles(gameDir);
  if (files.length === 0) {
    throw new Error(`validate: game directory is empty or not readable: ${entryPath(gameDir)}`);
  }
  if (files.length < MIN_GAME_FILES || files.length > MAX_GAME_FILES) {
    throw new Error(
      `validate: ${entryPath(gameDir)} holds ${files.length} files; must hold between ${MIN_GAME_FILES}–${MAX_GAME_FILES}`,
    );
  }

  for (const file of files) {
    const name = entryPath(file.path);
    const nameBytes = Buffer.byteLength(name, 'utf8');
    if (nameBytes >= MAX_PATH_BYTES) {
      throw new Error(`validate: path is ${nameBytes} bytes, must be < ${MAX_PATH_BYTES}: ${name}`);
    }
    if (file.bytes > MAX_FILE_BYTES) {
      throw new Error(`validate: file is ${file.bytes} bytes, max is ${MAX_FILE_BYTES}: ${name}`);
    }
  }
}

// Validate before anything is written: a failed entry leaves no half-built output behind.
validate();

mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });

// Copy the whole game tree, then the screenshots if this checkout has any (optional in development).
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
if (existsSync(join(here, 'screenshots'))) {
  cpSync(join(here, 'screenshots'), join(out, 'screenshots'), { recursive: true });
}

// dossier.json is the scorer's manifest: vendored signatures, hashes and the caps this entry was
// validated against. text_max_bytes leaves headroom for the metadata and badge strings.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);

// Summarise the copies only (the dossier is written after them and is not counted here).
const copiedGame = tally(join(out, 'game'));
const copiedShots = tally(join(out, 'screenshots'));
const copiedFiles = copiedGame.files + copiedShots.files;
const copiedBytes = copiedGame.bytes + copiedShots.bytes;

// Print results in a shape the scorer's harness can parse and a human can audit.
console.log(`game/        ${copiedGame.files} files, ${copiedGame.bytes} bytes`);
console.log(`screenshots/ ${copiedShots.files} files, ${copiedShots.bytes} bytes`);
console.log(`copied ${copiedFiles} files (${copiedBytes} bytes) into ${out}`);
console.log('VICE MERIDIAN build ok');
