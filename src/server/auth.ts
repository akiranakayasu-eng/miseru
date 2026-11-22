// 接続コードによる許可制。コードを入れた端末にだけトークンを渡し、操作はトークンがある接続だけ受け付ける。

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class PairingAuth {
  readonly code: string;
  private tokens: Set<string>;
  private failures = 0;
  private lockedUntil = 0;

  constructor(private tokenFile: string) {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.tokens = new Set(existsSync(tokenFile) ? (JSON.parse(readFileSync(tokenFile, 'utf8')) as string[]) : []);
  }

  /** 接続コードが正しければ新しいトークンを返す。続けて間違えると 1 分止める。 */
  pair(code: unknown): { token: string } | { error: string } {
    const now = Date.now();
    if (now < this.lockedUntil) return { error: 'Too many attempts. Wait a moment and try again.' };
    const given = Buffer.from(String(code ?? ''));
    const expected = Buffer.from(this.code);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      this.failures += 1;
      if (this.failures >= 5) {
        this.failures = 0;
        this.lockedUntil = now + 60_000;
      }
      return { error: 'Incorrect pairing code' };
    }
    this.failures = 0;
    const token = randomBytes(24).toString('base64url');
    this.tokens.add(token);
    this.save();
    return { token };
  }

  isValid(token: string | null | undefined): boolean {
    return !!token && this.tokens.has(token);
  }

  /** 登録済みの端末をすべて取り消す */
  revokeAll(): void {
    this.tokens.clear();
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.tokenFile), { recursive: true });
    writeFileSync(this.tokenFile, JSON.stringify([...this.tokens]));
  }
}
