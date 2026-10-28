/** Junta classes condicionais sem depender de bibliotecas externas. */
export function cx(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(" ");
}
