import { writeJsonAtomic } from './ledger.js';

/** 以临时文件写入、fsync 后原子替换，读者只会看到完整 JSON。 */
export async function writeResult(path, value) {
  await writeJsonAtomic(path, value);
}
