/** Native rendering keeps the operating system's display scale. */
export function getInterfaceScale(): number {
  return 1;
}
export function useInterfaceZoom(): [number, (value: number) => void] {
  return [100, () => {}];
}
export function useApplyInterfaceZoom(): void {}
