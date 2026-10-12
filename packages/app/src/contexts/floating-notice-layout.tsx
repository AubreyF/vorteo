import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type RegisterClearance = (height: number) => () => void;
const RegisterContext = createContext<RegisterClearance | null>(null);
const ClearanceContext = createContext(0);

/** Only active compact composers reserve space for app-wide floating notices. */
export function FloatingNoticeLayoutProvider({ children }: { children: ReactNode }) {
  const [reservations, setReservations] = useState<ReadonlyMap<symbol, number>>(() => new Map());
  const register = useCallback((height: number) => {
    const token = Symbol();
    setReservations((current) => new Map(current).set(token, height));
    return () => {
      setReservations((current) => {
        const next = new Map(current);
        next.delete(token);
        return next;
      });
    };
  }, []);
  const clearance = useMemo(() => Math.max(0, ...reservations.values()), [reservations]);
  return (
    <RegisterContext.Provider value={register}>
      <ClearanceContext.Provider value={clearance}>{children}</ClearanceContext.Provider>
    </RegisterContext.Provider>
  );
}

export function useFloatingNoticeClearance(active: boolean, bottomInset: number) {
  const register = useContext(RegisterContext);
  if (!register) throw new Error("Floating notice clearance requires FloatingNoticeLayoutProvider");
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (active && height > 0) return register(height + bottomInset);
  }, [active, height, bottomInset, register]);
  return setHeight;
}

export function useFloatingNoticeBottomClearance(): number {
  return useContext(ClearanceContext);
}
