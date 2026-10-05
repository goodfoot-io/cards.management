/**
 * Timing controls for verified checkout content removal, ported from WIP
 * 84583d9f89, plus the portability cases: persisted post-rename change times,
 * snapshot errors as blocked, umask-proof restore modes and the hash witness.
 * @summary Hold-verify-unlink removal refusal, restoration, and interrupted-removal recovery
 */
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  rmdir,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CheckoutContentChangedError,
  CheckoutRemovalBlockedError,
  type CheckoutRemovalOptions,
  CheckoutRestoredError,
  recoverCheckoutRemoval,
  removeQuarantinedCheckout,
  resolveCheckoutWitness,
  snapshotCheckout
} from '../src/checkout-removal.js';

const AGED = new Date('2020-01-01T00:00:00Z');
const POSIX = process.platform !== 'win32';

describe('verified checkout content removal', () => {
  let parent: string;
  let root: string;
  let holding: string;
  let servers: Server[];

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'cards-content-removal-'));
    root = join(parent, '.deleting-1-checkout');
    holding = `${root}.held`;
    servers = [];
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
    await writeFile(join(root, '.git'), 'gitdir: /repo/.git/worktrees/1\n');
    await writeFile(join(root, 'data.txt'), 'committed data\n');
    await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
    await writeFile(join(root, 'src', 'nested', 'deep.txt'), 'deep\n');
    await symlink('../shared/node_modules', join(root, 'node_modules'));
  });

  afterEach(async () => {
    for (const server of servers) server.close();
    await rm(parent, { recursive: true, force: true });
  });

  /**
   * Runs one removal with a no-op proof and owner fence unless overridden.
   * @param overrides - Option overrides for the scenario.
   * @returns The removal promise.
   */
  function remove(overrides: Partial<CheckoutRemovalOptions> = {}): Promise<void> {
    return removeQuarantinedCheckout(
      { root, holding, restoreTo: join(parent, '1') },
      { prove: async () => undefined, requireCurrent: () => undefined, ...overrides }
    );
  }

  /**
   * Captures every entry's bytes so a refusal can be compared with the original checkout.
   * @returns Pre-order relative paths with file contents, link targets, or kinds.
   */
  async function contents(): Promise<Array<[string, string]>> {
    return Promise.all(
      (await snapshotCheckout(root, 0n)).map(async (entry): Promise<[string, string]> => {
        if (entry.kind === 'file') return [entry.path, await readFile(join(root, entry.path), 'utf8')];
        if (entry.kind === 'symlink') return [entry.path, await readlink(join(root, entry.path))];
        return [entry.path, entry.kind];
      })
    );
  }

  /** Backdates every entry beyond the racy window so identity alone, not hashing, proves files unchanged. */
  async function age(): Promise<void> {
    for (const entry of await snapshotCheckout(root, 0n))
      if (entry.kind !== 'symlink') await utimes(join(root, entry.path), AGED, AGED);
  }

  /** A checkpoint that never returns, freezing removal as a crash would. */
  const frozen = (): Promise<void> => new Promise<void>(() => undefined);

  /**
   * Waits until a frozen removal has reached its checkpoint.
   * @param reached - Flag set by the checkpoint.
   */
  async function until(reached: () => boolean): Promise<void> {
    while (!reached()) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  it('removes every entry, its holding area, and the checkout root, moving the Git marker last', async () => {
    const visited: string[] = [];
    await remove({
      checkpoint: async (entry) => {
        if (entry !== holding) visited.push(entry.slice(root.length + 1));
      }
    });
    expect(await readdir(parent)).toEqual([]);
    expect(visited.at(-1)).toBe('.git');
    expect(visited.indexOf('src/nested/deep.txt')).toBeLessThan(visited.indexOf('src/nested'));
    expect(visited.indexOf('src/nested')).toBeLessThan(visited.indexOf('src'));
  });

  it('refuses and restores every entry when a write lands on a path before it is held', async () => {
    const before = await contents();
    const removal = remove({
      checkpoint: async (entry) => {
        if (entry === join(root, 'data.txt')) await writeFile(entry, 'LATE WRITE\n');
      }
    });
    await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    await expect(removal).rejects.toThrow(/data\.txt/);
    expect(await contents()).toEqual(
      before.map(([path, value]) => [path, path === 'data.txt' ? 'LATE WRITE\n' : value])
    );
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('catches a same-size write that restores the modification time through the unforgeable change time', async () => {
    await age();
    const removal = remove({
      checkpoint: async (entry) => {
        if (entry !== join(root, 'data.txt')) return;
        await writeFile(entry, 'COMMITTED DATA\n');
        await utimes(entry, AGED, AGED);
      }
    });
    await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('COMMITTED DATA\n');
  });

  it('restores from the manifest when a descriptor write reaches an already held file after the root is gone', async () => {
    await age();
    const handle = await open(join(root, 'data.txt'), 'r+');
    try {
      const removal = remove({
        checkpoint: async (entry) => {
          if (entry === join(root, '.git')) await handle.write('COMMITTED', 0);
        }
      });
      await expect(removal).rejects.toThrow(CheckoutRestoredError);
      await expect(removal).rejects.toThrow(new RegExp(`${holding.replaceAll('.', '\\.')}.*data\\.txt`));
    } finally {
      await handle.close();
    }
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('COMMITTED data\n');
    expect(await readFile(join(root, 'src', 'nested', 'deep.txt'), 'utf8')).toBe('deep\n');
    expect(await readlink(join(root, 'node_modules'))).toBe('../shared/node_modules');
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('keeps an atomic replacement in place and leaves no orphaned sibling', async () => {
    const removal = remove({
      checkpoint: async (entry) => {
        if (entry !== join(root, 'src')) return;
        await writeFile(join(entry, '.index.ts.tmp'), 'export const saved = true;\n');
        await rename(join(entry, '.index.ts.tmp'), join(entry, 'index.ts'));
      }
    });
    await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    expect(await readFile(join(root, 'src', 'index.ts'), 'utf8')).toBe('export const saved = true;\n');
    expect(await readdir(join(root, 'src'))).toEqual(['index.ts', 'nested']);
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('keeps a divergent held entry under a recovery name when its vacated path was recreated', async () => {
    const handle = await open(join(root, 'data.txt'), 'r+');
    try {
      const removal = remove({
        checkpoint: async (entry) => {
          if (entry !== join(root, '.git')) return;
          await handle.write('HELD EDIT', 0);
          await writeFile(join(root, 'data.txt'), 'recreated\n');
        }
      });
      await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    } finally {
      await handle.close();
    }
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('recreated\n');
    const recovered = (await readdir(root)).filter((name) => name.startsWith('data.txt.cards-recovered-'));
    expect(recovered).toHaveLength(1);
    expect(await readFile(join(root, recovered[0]!), 'utf8')).toBe('HELD EDIT data\n');
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('refuses a new file created inside an already emptied directory', async () => {
    const removal = remove({
      checkpoint: async (entry) => {
        if (entry === join(root, 'src', 'nested')) await writeFile(join(entry, 'new.txt'), 'new\n');
      }
    });
    await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    expect(await readFile(join(root, 'src', 'nested', 'new.txt'), 'utf8')).toBe('new\n');
    expect(await readFile(join(root, 'src', 'nested', 'deep.txt'), 'utf8')).toBe('deep\n');
  });

  it('restores every entry and rethrows when the owner fence is lost', async () => {
    const before = await contents();
    let calls = 0;
    const removal = remove({
      requireCurrent: () => {
        if (++calls === 3) throw new Error('lost ownership');
      }
    });
    await expect(removal).rejects.toThrow('lost ownership');
    expect(await contents()).toEqual(before);
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it.runIf(POSIX)('removes FIFOs and sockets by identity', async () => {
    execFileSync('mkfifo', [join(root, 'src', 'pipe')]);
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(join(root, 'sock'), resolve));
    await remove();
    expect(await readdir(parent)).toEqual([]);
  });

  it.runIf(POSIX)('refuses a special file replaced by another of the same kind', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const removal = remove({
      checkpoint: async (entry) => {
        if (entry !== join(root, 'pipe')) return;
        await rm(entry);
        execFileSync('mkfifo', [entry]);
      }
    });
    await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    expect((await lstat(join(root, 'pipe'))).isFIFO()).toBe(true);
  });

  it.each(['EBUSY', 'EPERM'])('reports a %s rename as a blocked operation and restores the checkout', async (code) => {
    const before = await contents();
    const removal = remove({
      filesystem: {
        rename: async (source, target) => {
          if (String(source).endsWith('deep.txt')) throw Object.assign(new Error(code), { code });
          await rename(source, target);
        }
      }
    });
    await expect(removal).rejects.toThrow(CheckoutRemovalBlockedError);
    await expect(removal).rejects.toMatchObject({ code, path: join('src', 'nested', 'deep.txt') });
    expect(await contents()).toEqual(before);
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('reports an EBUSY directory removal as a blocked operation, not a content change', async () => {
    const before = await contents();
    const removal = remove({
      filesystem: {
        rmdir: async (path) => {
          if (path === join(root, 'src')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
          await rmdir(path);
        }
      }
    });
    await expect(removal).rejects.toThrow(CheckoutRemovalBlockedError);
    expect(await contents()).toEqual(before);
  });

  it('restores by exclusive copy when the filesystem cannot hard link', async () => {
    const before = await contents();
    const removal = remove({
      checkpoint: async (entry) => {
        if (entry === join(root, '.git')) throw new Error('interrupted');
      },
      filesystem: {
        link: async () => {
          throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
        }
      }
    });
    await expect(removal).rejects.toThrow('interrupted');
    expect(await contents()).toEqual(before);
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('restores an interrupted removal from its manifest after the owner died mid-take', async () => {
    const before = await contents();
    let taken = 0;
    let reached = false;
    void remove({
      checkpoint: async (entry) => {
        if (entry === holding || ++taken < 4) return;
        reached = true;
        await frozen();
      }
    });
    await until(() => reached);
    await expect(recoverCheckoutRemoval(holding)).resolves.toMatchObject({
      kind: 'restored',
      root,
      restoreTo: join(parent, '1'),
      changed: [],
      displaced: []
    });
    expect(await contents()).toEqual(before);
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('clears a holding area that an interrupted removal created before writing its manifest', async () => {
    let reached = false;
    void remove({
      checkpoint: async (entry) => {
        if (entry !== holding) return;
        reached = true;
        await frozen();
      }
    });
    await until(() => reached);
    await expect(recoverCheckoutRemoval(holding)).resolves.toEqual({ kind: 'cleared' });
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('finishes a committed removal interrupted while unlinking verified entries', async () => {
    let reached = false;
    void remove({
      filesystem: {
        unlink: async () => {
          reached = true;
          await frozen();
        }
      }
    });
    await until(() => reached);
    await expect(recoverCheckoutRemoval(holding)).resolves.toEqual({ kind: 'finished', root });
    expect(await readdir(parent)).toEqual([]);
  });

  it('restores a committed removal whose held entry changed before recovery', async () => {
    let reached = false;
    void remove({
      filesystem: {
        unlink: async () => {
          reached = true;
          await frozen();
        }
      }
    });
    await until(() => reached);
    const manifest = JSON.parse(await readFile(join(holding, 'manifest.json'), 'utf8')) as {
      entries: Array<{ path: string }>;
    };
    const index = manifest.entries.findIndex((entry) => entry.path === 'data.txt');
    await writeFile(join(holding, String(index)), 'edited while held\n', { flag: 'r+' });
    await expect(recoverCheckoutRemoval(holding)).resolves.toMatchObject({ kind: 'restored', changed: ['data.txt'] });
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('edited while held\n');
    expect(await readdir(parent)).toEqual([basename(root)]);
  });

  it('refuses to recover a holding area with entries its manifest does not record', async () => {
    let reached = false;
    void remove({
      checkpoint: async (entry) => {
        if (entry !== join(root, '.git')) return;
        reached = true;
        await frozen();
      }
    });
    await until(() => reached);
    await writeFile(join(holding, 'stray'), 'unknown\n');
    await expect(recoverCheckoutRemoval(holding)).rejects.toThrow(/unrecorded stray/);
    expect(await readdir(holding)).toContain('manifest.json');
  });

  it('refuses a committed removal whose held file was rewritten with its size and modification time restored', async () => {
    await age();
    let reached = false;
    void remove({
      filesystem: {
        unlink: async () => {
          reached = true;
          await frozen();
        }
      }
    });
    await until(() => reached);
    const manifest = JSON.parse(await readFile(join(holding, 'manifest.json'), 'utf8')) as {
      entries: Array<{ path: string }>;
    };
    const held = join(holding, String(manifest.entries.findIndex((entry) => entry.path === 'data.txt')));
    await writeFile(held, 'COMMITTED DATA\n', { flag: 'r+' });
    await utimes(held, AGED, AGED);
    await expect(recoverCheckoutRemoval(holding)).resolves.toMatchObject({ kind: 'restored', changed: ['data.txt'] });
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('COMMITTED DATA\n');
  });

  it.runIf(POSIX && process.getuid?.() !== 0)(
    'reports an unreadable directory found by the snapshot as blocked and moves nothing',
    async () => {
      const before = await contents();
      await chmod(join(root, 'src', 'nested'), 0o000);
      try {
        const removal = remove();
        await expect(removal).rejects.toThrow(CheckoutRemovalBlockedError);
        await expect(removal).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(join(root, 'src', 'nested'), 0o755);
      }
      expect(await contents()).toEqual(before);
      expect(await readdir(parent)).toEqual([basename(root)]);
    }
  );

  it.runIf(POSIX)('restores directory and copied file modes regardless of the process umask', async () => {
    await chmod(join(root, 'src'), 0o755);
    await chmod(join(root, 'src', 'nested'), 0o751);
    await chmod(join(root, 'data.txt'), 0o644);
    await chmod(join(root, 'src', 'index.ts'), 0o640);
    const previous = process.umask(0o077);
    try {
      const removal = remove({
        checkpoint: async (entry) => {
          if (entry === join(root, '.git')) throw new Error('interrupted');
        },
        filesystem: {
          link: async () => {
            throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
          }
        }
      });
      await expect(removal).rejects.toThrow('interrupted');
    } finally {
      process.umask(previous);
    }
    expect((await lstat(join(root, 'src'))).mode & 0o777).toBe(0o755);
    expect((await lstat(join(root, 'src', 'nested'))).mode & 0o777).toBe(0o751);
    expect((await lstat(join(root, 'data.txt'))).mode & 0o777).toBe(0o644);
    expect((await lstat(join(root, 'src', 'index.ts'))).mode & 0o777).toBe(0o640);
  });

  it('records a content hash for every regular file under the hash witness', async () => {
    await age();
    const files = (await snapshotCheckout(root, 0n, 'hash')).filter((entry) => entry.kind === 'file');
    expect(files.length).toBeGreaterThan(0);
    for (const entry of files) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    const now = BigInt(Date.now()) * 1_000_000n;
    expect((await snapshotCheckout(root, now, 'ctime')).some((entry) => entry.sha256 !== undefined)).toBe(false);
  });

  it('refuses a same-size rewrite with its modification time restored through the hash witness', async () => {
    await age();
    const removal = remove({
      witness: 'hash',
      checkpoint: async (entry) => {
        if (entry !== join(root, 'data.txt')) return;
        await writeFile(entry, 'COMMITTED DATA\n');
        await utimes(entry, AGED, AGED);
      }
    });
    await expect(removal).rejects.toThrow(CheckoutContentChangedError);
    expect(await readFile(join(root, 'data.txt'), 'utf8')).toBe('COMMITTED DATA\n');
  });

  it.runIf(POSIX)(
    'ignores a change-time-only update under the hash witness, where change time is settable',
    async () => {
      await age();
      await remove({
        witness: 'hash',
        checkpoint: async (entry) => {
          if (entry !== join(root, 'data.txt')) return;
          const { mode } = await lstat(entry);
          await chmod(entry, 0o600);
          await chmod(entry, mode);
        }
      });
      expect(await readdir(parent)).toEqual([]);
    }
  );

  it('records the witness in the manifest', async () => {
    let reached = false;
    void remove({
      witness: 'hash',
      checkpoint: async (entry) => {
        if (entry !== join(root, '.git')) return;
        reached = true;
        await frozen();
      }
    });
    await until(() => reached);
    const manifest = JSON.parse(await readFile(join(holding, 'manifest.json'), 'utf8')) as { witness: string };
    expect(manifest.witness).toBe('hash');
  });
});

describe('checkout witness resolution', () => {
  it('uses the hash witness on Windows whatever the volume', async () => {
    await expect(resolveCheckoutWitness(tmpdir(), { platform: 'win32', statfsType: async () => 0xef53 })).resolves.toBe(
      'hash'
    );
  });

  it.each([
    ['MSDOS', 0x4d44],
    ['exFAT', 0x2011bab0],
    ['NFS', 0x6969],
    ['SMB', 0x517b],
    ['CIFS', 0xff534d42],
    ['SMB2', 0xfe534d42]
  ])('uses the hash witness on a Linux %s volume', async (_name, type) => {
    await expect(resolveCheckoutWitness(tmpdir(), { platform: 'linux', statfsType: async () => type })).resolves.toBe(
      'hash'
    );
  });

  it('uses the change-time witness on a Linux ext4 volume', async () => {
    await expect(resolveCheckoutWitness(tmpdir(), { platform: 'linux', statfsType: async () => 0xef53 })).resolves.toBe(
      'ctime'
    );
  });

  it('fails closed to the hash witness when a Linux volume type is unreadable', async () => {
    await expect(resolveCheckoutWitness(tmpdir(), { platform: 'linux', statfsType: async () => null })).resolves.toBe(
      'hash'
    );
  });

  it('uses the change-time witness on macOS', async () => {
    await expect(resolveCheckoutWitness(tmpdir(), { platform: 'darwin' })).resolves.toBe('ctime');
  });

  it('resolves a witness for the real temporary volume', async () => {
    await expect(resolveCheckoutWitness(tmpdir())).resolves.toMatch(/^(ctime|hash)$/);
  });
});
