/**
 * Environment for `expo export`. Metro's transform workers inherit NODE_OPTIONS;
 * at V8's default ~4 GB heap one worker ran out of memory on the generated protocol
 * validators and failed a Host install at random (job a32f29a1). The export alone
 * gets a larger heap; appended last so it wins over any inherited setting.
 */
export const WEB_EXPORT_HEAP_MB = 8192;

export function webExportEnvironment(env = process.env) {
  return {
    NODE_OPTIONS: [env.NODE_OPTIONS, `--max-old-space-size=${WEB_EXPORT_HEAP_MB}`]
      .filter(Boolean)
      .join(" "),
  };
}
