'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, ExternalLink, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';

interface CollectionMatch {
  discogsId: number;
  title: string;
  artist: string;
  year: number | null;
  addedManually: boolean;
}

interface UnmatchedItem {
  id: number;
  catalogNumber: string;
  artist: string;
  title: string;
  rawDescription: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  searchQuery: string;
  lastDiscogsMissAt: string | null;
  collectionMatch: CollectionMatch | null;
}

interface SearchCandidate {
  id: number;
  title: string;
  year: string | null;
  country: string | null;
  format: string[];
  labels: string[];
  catalogNumber: string | null;
  thumb: string | null;
  discogsUrl: string;
  score: number;
  confidence: 'strong' | 'possible' | 'weak';
  reasons: string[];
  inCollection: boolean;
}

interface SearchState {
  candidates: SearchCandidate[];
  importId: string;
  selectedReleaseId: number | null;
  folderId: number | null;
}

interface CollectionFolder {
  id: number;
  name: string;
  count: number;
}

const confidenceClassNames: Record<SearchCandidate['confidence'], string> = {
  strong: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  possible: 'border-amber-200 bg-amber-50 text-amber-800',
  weak: 'border-gray-200 bg-gray-50 text-gray-700',
};

function formatCheckedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

export default function UnmatchedInvoicePanel({
  collectionFolders,
  isLoadingFolders,
  folderError,
  defaultFolderId,
}: {
  collectionFolders: CollectionFolder[];
  isLoadingFolders: boolean;
  folderError: string | null;
  defaultFolderId: number | null;
}) {
  const [items, setItems] = useState<UnmatchedItem[]>([]);
  const [queries, setQueries] = useState<Record<number, string>>({});
  const [searchById, setSearchById] = useState<Record<number, SearchState>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [rowError, setRowError] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadItems() {
      setIsLoading(true);
      setLoadError(null);
      try {
        const response = await fetch('/api/invoices/deejay?action=unmatched');
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.error || 'Failed to load unmatched invoice lines');
        }
        if (!cancelled) {
          const nextItems = (payload.items || []) as UnmatchedItem[];
          setItems(nextItems);
          setQueries((current) => {
            const next = { ...current };
            for (const item of nextItems) {
              if (next[item.id] === undefined) {
                next[item.id] = item.searchQuery;
              }
            }
            return next;
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load unmatched invoice lines');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadItems();
    return () => {
      cancelled = true;
    };
  }, []);

  const removeItem = (id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    setSearchById((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const dismissItem = async (id: number) => {
    setBusyId(id);
    setRowError((current) => ({ ...current, [id]: '' }));
    try {
      const response = await fetch('/api/invoices/deejay?action=unmatched-dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to dismiss this line');
      }
      removeItem(id);
    } catch (error) {
      setRowError((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : 'Failed to dismiss this line',
      }));
    } finally {
      setBusyId(null);
    }
  };

  const searchItem = async (item: UnmatchedItem) => {
    setBusyId(item.id);
    setRowError((current) => ({ ...current, [item.id]: '' }));
    try {
      const response = await fetch('/api/invoices/deejay?action=unmatched-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id, query: queries[item.id] ?? item.searchQuery }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Discogs search failed');
      }

      if (typeof payload.searchQuery === 'string') {
        setQueries((current) => ({ ...current, [item.id]: payload.searchQuery }));
      }

      if (payload.outcome === 'in-collection') {
        setItems((current) => current.map((currentItem) => (
          currentItem.id === item.id
            ? { ...currentItem, collectionMatch: payload.match, searchQuery: payload.searchQuery }
            : currentItem
        )));
        setSearchById((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        return;
      }

      if (payload.outcome === 'not-found') {
        setItems((current) => current.map((currentItem) => (
          currentItem.id === item.id
            ? {
                ...currentItem,
                collectionMatch: null,
                lastDiscogsMissAt: payload.checkedAt,
                searchQuery: payload.searchQuery,
              }
            : currentItem
        )));
        setSearchById((current) => {
          const next = { ...current };
          delete next[item.id];
          return next;
        });
        return;
      }

      const candidates = (payload.candidates || []) as SearchCandidate[];
      setItems((current) => current.map((currentItem) => (
        currentItem.id === item.id
          ? { ...currentItem, collectionMatch: null, searchQuery: payload.searchQuery }
          : currentItem
      )));
      setSearchById((current) => ({
        ...current,
        [item.id]: {
          candidates,
          importId: payload.importId,
          selectedReleaseId: candidates[0]?.id ?? null,
          folderId: defaultFolderId,
        },
      }));
    } catch (error) {
      setRowError((current) => ({
        ...current,
        [item.id]: error instanceof Error ? error.message : 'Discogs search failed',
      }));
    } finally {
      setBusyId(null);
    }
  };

  const addItem = async (item: UnmatchedItem) => {
    const search = searchById[item.id];
    if (!search?.selectedReleaseId || !search.folderId || !search.importId) {
      return;
    }

    setBusyId(item.id);
    setRowError((current) => ({ ...current, [item.id]: '' }));
    try {
      const response = await fetch('/api/invoices/deejay?action=unmatched-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: item.id,
          releaseId: search.selectedReleaseId,
          folderId: search.folderId,
          importId: search.importId,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || 'Failed to add this release');
      }
      if (!payload.removed) {
        const failed = (payload.results || []).find((result: { error?: string }) => result.error);
        throw new Error(failed?.error || 'This release was not added');
      }
      removeItem(item.id);
    } catch (error) {
      setRowError((current) => ({
        ...current,
        [item.id]: error instanceof Error ? error.message : 'Failed to add this release',
      }));
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading unmatched invoice lines...</p>;
  }

  if (loadError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        <AlertCircle className="h-4 w-4" />
        {loadError}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Not found during past imports</CardTitle>
          <CardDescription>No unmatched invoice lines.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const search = searchById[item.id];
        const busy = busyId === item.id;
        return (
          <Card key={item.id} className="rounded-lg">
            <CardHeader>
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="text-lg">{item.catalogNumber} - {item.artist}</CardTitle>
                  <CardDescription>{item.title}</CardDescription>
                </div>
                <div className="text-sm text-muted-foreground">
                  {[item.invoiceNumber, item.invoiceDate].filter(Boolean).join(' · ') || 'Invoice unknown'}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {item.rawDescription && (
                <p className="text-sm text-muted-foreground">{item.rawDescription}</p>
              )}

              {item.collectionMatch && (
                <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4" />
                    <div className="space-y-1">
                      <div>
                        Already in your collection
                        {item.collectionMatch.addedManually ? ', added outside an invoice import' : ''}: {item.collectionMatch.artist} — {item.collectionMatch.title}
                        {item.collectionMatch.year ? ` (${item.collectionMatch.year})` : ''}.
                      </div>
                      <a
                        href={`https://www.discogs.com/release/${item.collectionMatch.discogsId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-900 hover:underline"
                      >
                        Open Discogs
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {!item.collectionMatch && item.lastDiscogsMissAt && (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                  Not found on Discogs. Checked {formatCheckedAt(item.lastDiscogsMissAt)}. Try this search again later.
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  value={queries[item.id] ?? item.searchQuery}
                  onChange={(event) => setQueries((current) => ({ ...current, [item.id]: event.target.value }))}
                  aria-label={`Search query for ${item.catalogNumber}`}
                  data-testid={`unmatched-search-query-${item.id}`}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
                <Button
                  data-testid={`unmatched-search-${item.id}`}
                  onClick={() => void searchItem(item)}
                  disabled={busy}
                >
                  <Search className="h-4 w-4" />
                  Search again
                </Button>
                <Button
                  variant="outline"
                  data-testid={`unmatched-dismiss-${item.id}`}
                  onClick={() => void dismissItem(item.id)}
                  disabled={busy}
                >
                  Dismiss
                </Button>
              </div>

              {rowError[item.id] && (
                <div className="text-sm text-red-700">{rowError[item.id]}</div>
              )}

              {search && (
                <div className="grid gap-3">
                  {search.candidates.map((candidate) => {
                    const selected = search.selectedReleaseId === candidate.id;
                    return (
                      <label
                        key={candidate.id}
                        className={`grid cursor-pointer gap-3 rounded-lg border p-3 md:grid-cols-[auto_72px_1fr] ${
                          selected ? 'border-blue-400 bg-blue-50' : 'border-border bg-background'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`unmatched-${item.id}`}
                          checked={selected}
                          onChange={() => setSearchById((current) => ({
                            ...current,
                            [item.id]: { ...search, selectedReleaseId: candidate.id },
                          }))}
                          className="mt-2"
                        />
                        <div className="h-[72px] w-[72px] overflow-hidden rounded-md bg-muted">
                          {candidate.thumb ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={candidate.thumb} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-xs text-muted-foreground">No art</div>
                          )}
                        </div>
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div>
                              <div className="font-semibold text-blue-700">{candidate.title}</div>
                              <div className="text-sm text-muted-foreground">
                                {[candidate.catalogNumber, candidate.year, candidate.country].filter(Boolean).join(' | ')}
                              </div>
                            </div>
                            <div className={`w-fit rounded-full border px-2 py-1 text-xs font-medium ${confidenceClassNames[candidate.confidence]}`}>
                              {candidate.confidence} · {candidate.score}
                            </div>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {[...candidate.labels, ...candidate.format].filter(Boolean).join(' · ')}
                          </div>
                          {candidate.inCollection && (
                            <div className="w-fit rounded-full border border-emerald-200 bg-emerald-100 px-2 py-1 text-xs font-medium text-emerald-800">
                              In collection
                            </div>
                          )}
                          <a
                            href={candidate.discogsUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-sm text-blue-700 hover:underline"
                          >
                            Open Discogs
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </label>
                    );
                  })}
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
                    <Select
                      value={String(search.folderId || '')}
                      onChange={(event) => {
                        const folderId = Number(event.target.value);
                        if (!Number.isInteger(folderId)) {
                          return;
                        }
                        setSearchById((current) => ({
                          ...current,
                          [item.id]: { ...search, folderId },
                        }));
                      }}
                      disabled={isLoadingFolders || collectionFolders.length === 0}
                      aria-label={`Discogs folder for ${item.catalogNumber}`}
                      className="bg-white sm:w-64"
                    >
                      <option value="" disabled>
                        {isLoadingFolders ? 'Loading folders...' : 'Choose folder'}
                      </option>
                      {collectionFolders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {folder.name} ({folder.count})
                        </option>
                      ))}
                    </Select>
                    <Button
                      data-testid={`unmatched-add-${item.id}`}
                      onClick={() => void addItem(item)}
                      disabled={busy || !search.selectedReleaseId || !search.folderId || Boolean(folderError)}
                    >
                      Add selected
                    </Button>
                  </div>
                  {folderError && <div className="text-sm text-red-700">{folderError}</div>}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
