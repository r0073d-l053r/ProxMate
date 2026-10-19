/**
 * The quota dialogs (admin edit, user request) edit RAM in whole GB, but the stored quota is MB and need
 * not be a GB multiple (an approved quota request can grant e.g. 1536 MB).
 */

/** The GB value the RAM field is seeded with for a quota of `maxRamMb`. */
export function ramGbField(maxRamMb: number): number {
  return Math.round(maxRamMb / 1024);
}

/**
 * The MB value to save. While the field still shows its seeded value the admin
 * hasn't touched RAM, so the original quota is kept exactly — saving another field
 * (CPU, storage, the access window) must not round it.
 */
export function ramMbToSave(originalMb: number, ramGb: number): number {
  return ramGb === ramGbField(originalMb) ? originalMb : ramGb * 1024;
}
