import { useEffect, useState } from "react";
import { sourceKey, statusPagesEditorApi, type StatusItemSource, type StatusPageDetail } from "./statusPagesEditorApi";

export type CatalogItem = { key: string; source: StatusItemSource; displayName: string; pageId: number };

export function pageItems(page: StatusPageDetail): CatalogItem[] {
  return page.groups.flatMap((group) => group.items.map((item) => ({
    key: sourceKey(item.source), source: item.source, displayName: item.display_name, pageId: page.id,
  })));
}

export type ItemChoice = { key: string; source: StatusItemSource; label: string; aliases: string[] };

export function itemChoices(pages: StatusPageDetail[], firstPageId: number): ItemChoice[] {
  const ordered = [...pages].sort((a, b) => Number(b.id === firstPageId) - Number(a.id === firstPageId));
  const choices = new Map<string, ItemChoice>();
  ordered.flatMap(pageItems).forEach((item) => {
    const existing = choices.get(item.key);
    if (!existing) choices.set(item.key, { key: item.key, source: item.source, label: item.displayName, aliases: [] });
    else if (item.displayName !== existing.label && !existing.aliases.includes(item.displayName)) existing.aliases.push(item.displayName);
  });
  return [...choices.values()];
}

export function useStatusPageCatalog(accessToken: string, nonce = 0) {
  const [pages, setPages] = useState<StatusPageDetail[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    statusPagesEditorApi.list(accessToken)
      .then((summaries) => Promise.all(summaries.map((summary) => statusPagesEditorApi.get(accessToken, summary.id))))
      .then((details) => { if (!cancelled) { setPages(details); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load status pages"); });
    return () => { cancelled = true; };
  }, [accessToken, nonce]);

  return { pages, error };
}
