import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";
import { storageKeys, readString, writeString } from "../utils/storage";
import {
  builtInIconPack, fullTablerIconPack, loadFullTablerIconPack, loadIconPacks, readLocalIconPacks, writeLocalIconPacks,
  applyIconPackSelection, refreshDeviceTypeIconMap, type IconPack,
} from "../icons";

type IconPackApi = {
  iconPacks: IconPack[];
  localIconPacks: IconPack[];
  activeIconPackId: string;
  iconPackLoading: boolean;
  iconPackError: string | null;
  selectIconPack: (packId: string) => void;
  addLocalIconPack: (pack: IconPack) => void;
  removeLocalIconPack: (packId: string) => void;
  loadFullIconSet: () => void;
  iconsRevision: number;
};

const IconPackCtx = createContext<IconPackApi | null>(null);

export function useIconPacks(): IconPackApi {
  const api = useContext(IconPackCtx);
  if (!api) throw new Error("useIconPacks must be used inside <IconPackProvider>");
  return api;
}

export function IconPackProvider({ children }: { children: ReactNode }) {
  const [iconPacks, setIconPacks] = useState<IconPack[]>([]);
  const [localIconPacks, setLocalIconPacks] = useState<IconPack[]>(() => readLocalIconPacks());
  const [tablerPack, setTablerPack] = useState<IconPack>(fullTablerIconPack);
  const [iconPackLoading, setIconPackLoading] = useState(true);
  const [activeIconPackId, setActiveIconPackId] = useState(
    () => readString(storageKeys.iconPack) || builtInIconPack.id,
  );
  const [iconPackError, setIconPackError] = useState<string | null>(null);
  const [iconsRevision, setIconsRevision] = useState(0);

  const loadFullIconSet = useCallback(() => {
    void loadFullTablerIconPack().then(setTablerPack);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const tablerChosen = readString(storageKeys.iconPack) === fullTablerIconPack.id;
    async function bootstrapIconPacks() {
      setIconPackLoading(true);
      const [loaded, fullTabler] = await Promise.all([
        loadIconPacks(),
        tablerChosen ? loadFullTablerIconPack() : null,
      ]);
      if (cancelled) return;
      setIconPacks(loaded);
      if (fullTabler) setTablerPack(fullTabler);
      setIconPackLoading(false);
      setIconPackError(null);
    }
    void bootstrapIconPacks();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeLocalIconPacks(localIconPacks);
  }, [localIconPacks]);

  useEffect(() => {
    const merged = [...iconPacks];
    localIconPacks.forEach((pack) => {
      const existingIndex = merged.findIndex((row) => row.id === pack.id);
      if (existingIndex >= 0) merged[existingIndex] = pack;
      else merged.push(pack);
    });
    const available = [builtInIconPack, tablerPack, ...merged];
    const selected = available.some((pack) => pack.id === activeIconPackId) ? activeIconPackId : builtInIconPack.id;
    applyIconPackSelection(available, selected);
    refreshDeviceTypeIconMap();
    setIconsRevision((current) => current + 1);
    if (selected !== activeIconPackId) {
      setActiveIconPackId(selected);
      setIconPackError("Selected icon pack was not found; reverted to Built-in.");
      return;
    }
    writeString(storageKeys.iconPack, selected);
  }, [activeIconPackId, iconPacks, localIconPacks, tablerPack]);

  const api = useMemo<IconPackApi>(() => ({
    iconPacks,
    localIconPacks,
    activeIconPackId,
    iconPackLoading,
    iconPackError,
    selectIconPack: (packId: string) => {
      setIconPackError(null);
      setActiveIconPackId(packId);
      if (packId === fullTablerIconPack.id) loadFullIconSet();
    },
    addLocalIconPack: (pack: IconPack) => {
      setLocalIconPacks((current) => {
        const index = current.findIndex((row) => row.id === pack.id);
        if (index >= 0) {
          const next = [...current];
          next[index] = pack;
          return next;
        }
        return [...current, pack];
      });
    },
    removeLocalIconPack: (packId: string) => {
      setLocalIconPacks((current) => current.filter((row) => row.id !== packId));
      setActiveIconPackId((current) => (current === packId ? builtInIconPack.id : current));
    },
    loadFullIconSet,
    iconsRevision,
  }), [iconPacks, localIconPacks, activeIconPackId, iconPackLoading, iconPackError, loadFullIconSet, iconsRevision]);

  return <IconPackCtx.Provider value={api}>{children}</IconPackCtx.Provider>;
}
