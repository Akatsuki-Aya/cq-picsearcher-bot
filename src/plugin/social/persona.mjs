import { readFile } from 'fs/promises';
import { resolveByDirname } from '../../utils/path.mjs';

// Resolve from the project root, not the process working directory (PM2/Docker may differ).
export async function loadPersona(config, log = console.error) {
  const fallback = config.persona || '';
  if (!config.personaFile?.trim()) return fallback;
  const path = resolveByDirname(import.meta.url, '../../../', config.personaFile.trim());
  try {
    const text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (!text) throw new Error('人设文件为空');
    return text;
  } catch (error) {
    log(`[social] 无法读取人设文件 ${path}，使用 persona 配置: ${error.message}`);
    return fallback;
  }
}
