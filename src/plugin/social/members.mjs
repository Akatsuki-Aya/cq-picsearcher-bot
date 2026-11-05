import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolveByDirname } from '../../utils/path.mjs';

// Synchronous read/merge/atomic rename keeps updates serialized within one bot process.
export class MemberStore {
  constructor(directory = resolveByDirname(import.meta.url, '../../../data/social-members')) {
    this.directory = directory;
  }

  path(groupId) {
    if (!/^\d+$/.test(String(groupId))) throw new Error('Invalid group ID');
    return join(this.directory, `${groupId}.json`);
  }

  load(groupId) {
    const path = this.path(groupId);
    if (!existsSync(path)) return {};
    const value = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid member file');
    return value;
  }

  read(groupId) {
    return Object.entries(this.load(groupId)).filter(([id]) => /^\d+$/.test(id)).slice(0, 200)
      .map(([userId, value]) => ({ userId,
        aliases: Array.isArray(value?.aliases) ? value.aliases.filter(x => typeof x === 'string').slice(0, 20).map(x => x.slice(0, 40)) : [],
      }));
  }

  save(groupId, updates, history) {
    const members = this.load(groupId); // Re-read so manual edits take effect before merging.
    let changed = false;
    for (const update of (Array.isArray(updates) ? updates : []).slice(0, 10)) {
      const id = String(update?.userId);
      if (!/^\d+$/.test(id) || !history.some(m => !m.isSelf && m.userId === id)) continue;
      if (members[id]?.locked === true) continue;
      const evidence = history.find(m => !m.isSelf && m.messageId === String(update.messageId));
      if (!evidence || !Array.isArray(update.aliases)) continue;
      const aliases = update.aliases.filter(alias => typeof alias === 'string' && alias.trim() && alias.length <= 40
        && (evidence.text.includes(alias) || (evidence.userId === id && evidence.name === alias)));
      if (!aliases.length) continue;
      if (!members[id] && Object.keys(members).length >= 200) continue;
      const old = Array.isArray(members[id]?.aliases) ? members[id].aliases.filter(x => typeof x === 'string') : [];
      const merged = [...new Set([...old, ...aliases])].slice(0, 20);
      if (JSON.stringify(merged) === JSON.stringify(old)) continue;
      members[id] = { ...members[id], aliases: merged };
      changed = true;
    }
    if (!changed) return;
    const path = this.path(groupId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(members, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
}
