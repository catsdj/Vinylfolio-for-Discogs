'use client';

import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from '@/components/ui/table';
import StyleMultiSelect from '@/components/StyleMultiSelect';
import TagPicker from '@/components/TagPicker';
import FilterDropdown, { FilterDropdownRef } from '@/components/FilterDropdown';
import { clearCache, getCacheStats } from '@/lib/cache';
import { isValidDiscogsUrl, isValidYouTubeUrl } from '@/lib/clientSecurity';
import { YouTubePlaylistEmbed } from '@/components/YouTubePlaylistEmbed';
import { YouTubeVideoEmbed } from '@/components/YouTubeVideoEmbed';
import { extractYouTubePlaylistId, extractYouTubeVideoId } from '@/lib/urlValidation';
import { buildYouTubeEmbedUrl, formatYouTubeDuration } from '@/lib/youtubeEmbed';
import { FileText, ListMusic, Search, TrendingUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { usePlaylists } from '@/hooks/usePlaylists';
import { useTags } from '@/hooks/useTags';
import type { CollectionTag } from '@/lib/tagName';
import SetupRequiredCard from '@/components/SetupRequiredCard';
import CollectionSidebar, {
  COLLECTION_PAGE_SIZES,
  CollectionActionNotes,
  CollectionCardSortingControls,
  CollectionRowsPerPageDropdown,
  CollectionSyncPeriodSelect,
  CollectionViewToggle,
} from '@/components/CollectionSidebar';
import {
  CollectionSyncPeriod,
  getCollectionSyncPeriodLabel,
  parseCollectionSyncPeriod,
} from '@/lib/collectionSyncPeriod';
import { createOperationStatusPoller } from '@/lib/discogsOperationPolling';

const SETUP_REQUIRED_CODE = 'SETUP_REQUIRED';

type SetupInfo = {
  configured: boolean;
  missing: string[];
  message: string | null;
  steps: string[];
  quickSetup: string;
};

type DiscogsOperationJob = {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'stopped';
  period?: CollectionSyncPeriod;
  progress?: number;
  total?: number;
  processed?: number;
  error?: string | null;
  results?: {
    releasesUpdated?: number;
    newReleases?: number;
    conditionsUpdated?: number;
    removedReleases?: number;
    errors?: number;
  };
};

const idleDiscogsOperation: DiscogsOperationJob = { status: 'idle' };

async function readJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new Error('NON_JSON_RESPONSE');
  }
  return response.json();
}

// Helper function to format currency with proper symbols
function formatCurrency(amount: number, currency: string = 'USD'): string {
  const locale = currency === 'EUR' ? 'de-DE' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

interface DiscogsRelease {
  id: number;
  basic_information: {
    id: number;
    title: string;
    year: number;
    cover_image: string;
    artists: Array<{ name: string }>;
    styles: string[];
    genres: string[];
    labels: Array<{ name: string }>;
  };
  date_added: string;
  media_condition?: string;
  sleeve_condition?: string;
  notes?: Array<{
    field_id: number;
    value: string;
  }>;
  videos?: Array<{
    uri: string;
    title: string;
    description: string;
    duration: number;
    embed: boolean;
  }>;
  tracklist?: Array<{
    position: string;
    title: string;
    duration: string;
    type_: string;
  }>;
  priceInfo?: {
    lowest_price: number | null;
    currency: string;
  };
  youtubePlaylistId?: string;
  youtubeVideoId?: string;
  discogsVideos?: Array<{ videoId: string; title: string; duration: string }>;
  tags?: CollectionTag[];
}

interface ReleaseDetailsState {
  videos: any[];
  tracklist: any[];
  priceInfo?: any;
  media_condition?: string | null;
  sleeve_condition?: string | null;
}

interface CollectionData {
  releases: DiscogsRelease[];
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    items: number;
  };
  availableStyles: string[];
  availableTags?: string[];
  totalFiltered: number;
  totalCollection: number;
  getAllStyles?: boolean;
}

interface CollectionFilters {
  searchFilter: string;
  artistFilter: string;
  titleFilter: string;
  labelFilter: string;
  yearMinFilter: string;
  yearMaxFilter: string;
  yearValueFilter: string;
  dateAddedMinFilter: string;
  dateAddedMaxFilter: string;
  styleFilter: string[];
  tagFilter: string[];
  selectedTags: string[];
}

export default function DiscogsCollection() {
  const searchParams = useSearchParams();
  const {
    playlists,
    toggleReleaseInPlaylist,
  } = usePlaylists();
  const {
    tags: tagVocabulary,
    addTagToRelease,
    removeTagFromRelease,
  } = useTags();
  const [isCollectionLoading, setIsCollectionLoading] = useState(false);
  const [syncOperation, setSyncOperation] = useState<DiscogsOperationJob>(idleDiscogsOperation);
  const [updateOperation, setUpdateOperation] = useState<DiscogsOperationJob>(idleDiscogsOperation);
  const [syncPeriod, setSyncPeriod] = useState<CollectionSyncPeriod>('all');
  const operationRefreshPendingRef = useRef({ sync: false, update: false });
  const operationPollerRef = useRef<{ start: () => Promise<void> } | null>(null);
  const [data, setData] = useState<CollectionData | null>(null);
  const [styleFilterOpen, setStyleFilterOpen] = useState(false);
  const [tagFilterOpen, setTagFilterOpen] = useState(false);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupInfo | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [allAvailableStyles, setAllAvailableStyles] = useState<string[]>([]);
  const [includeDetails, setIncludeDetails] = useState(true);
  const [releaseDetails, setReleaseDetails] = useState<Record<number, ReleaseDetailsState>>({});
  const [cacheStats, setCacheStats] = useState({ totalCached: 0, cacheSize: '0 KB' });
  const [rateLimitStatus, setRateLimitStatus] = useState({ 
    requestsThisMinute: 0, 
    remainingRequests: 60, 
    queueLength: 0 
  });
  const [rowsPerPage, setRowsPerPage] = useState(COLLECTION_PAGE_SIZES[1]);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [hasLoadedViewPreferences, setHasLoadedViewPreferences] = useState(false);
  const isSyncing = syncOperation.status === 'running';
  const isUpdating = updateOperation.status === 'running';
  
  // Job state
  const [jobStatus, setJobStatus] = useState<{
    id: string | null;
    status: 'idle' | 'pending' | 'running' | 'completed' | 'failed';
    progress: number;
    total: number;
    processed: number;
    startTime: Date | null;
    endTime: Date | null;
    error: string | null;
    results: {
      videosLoaded: number;
      pricesLoaded: number;
      errors: number;
    };
  }>({
    id: null,
    status: 'idle',
    progress: 0,
    total: 0,
    processed: 0,
    startTime: null,
    endTime: null,
    error: null,
    results: {
      videosLoaded: 0,
      pricesLoaded: 0,
      errors: 0
    }
  });
  
  // Filter states
  const [searchInput, setSearchInput] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [artistFilter, setArtistFilter] = useState('');
  const [titleFilter, setTitleFilter] = useState('');
  const [labelFilter, setLabelFilter] = useState('');
  const [yearMinFilter, setYearMinFilter] = useState('');
  const [yearMaxFilter, setYearMaxFilter] = useState('');
  const [dateAddedMinFilter, setDateAddedMinFilter] = useState('');
  const [dateAddedMaxFilter, setDateAddedMaxFilter] = useState('');
  const [yearValueFilter, setYearValueFilter] = useState('');
  const [styleFilter, setStyleFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  
  // Sorting state
  const [sortColumn, setSortColumn] = useState<string>('date_added');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  
  // Filter dropdown state
  const [activeFilterColumn, setActiveFilterColumn] = useState<string | null>(null);
  const [filterDropdownPosition, setFilterDropdownPosition] = useState({ top: 0, left: 0 });
  const filterDropdownRef = useRef<FilterDropdownRef>(null);
  const searchedReleaseIdsRef = useRef<Set<number>>(new Set());
  const searchingReleaseIdRef = useRef<number | null>(null);
  const selectedStylesRef = useRef<string[]>([]);
  const selectedTagsRef = useRef<string[]>([]);

  useEffect(() => {
    selectedStylesRef.current = selectedStyles;
  }, [selectedStyles]);

  useEffect(() => {
    selectedTagsRef.current = selectedTags;
  }, [selectedTags]);

  const getActiveFilters = (): CollectionFilters => ({
    searchFilter,
    artistFilter,
    titleFilter,
    labelFilter,
    yearMinFilter,
    yearMaxFilter,
    yearValueFilter,
    dateAddedMinFilter,
    dateAddedMaxFilter,
    styleFilter,
    tagFilter,
    selectedTags,
  });

  const buildCollectionParams = (
    styles: string[] = [],
    page: number = 1,
    withDetails: boolean = includeDetails,
    customPerPage?: number,
    filterOverrides?: Partial<CollectionFilters>,
    sortOverrides?: { sortColumn?: string; sortDirection?: 'asc' | 'desc' }
  ) => {
    const filters = { ...getActiveFilters(), ...filterOverrides };
    const params = new URLSearchParams();

    if (styles.length > 0) {
      params.set('styles', styles.join(','));
    }

    params.set('page', page.toString());
    params.set('per_page', (customPerPage || rowsPerPage).toString());
    params.set('sort_column', sortOverrides?.sortColumn || sortColumn);
    params.set('sort_direction', sortOverrides?.sortDirection || sortDirection);

    if (withDetails) {
      params.set('include_details', 'true');
    }

    if (filters.searchFilter) {
      params.set('search', filters.searchFilter);
    }
    if (filters.artistFilter) {
      params.set('artist', filters.artistFilter);
    }
    if (filters.titleFilter) {
      params.set('title', filters.titleFilter);
    }
    if (filters.labelFilter) {
      params.set('label', filters.labelFilter);
    }
    if (filters.yearMinFilter) {
      params.set('year_min', filters.yearMinFilter);
    }
    if (filters.yearMaxFilter) {
      params.set('year_max', filters.yearMaxFilter);
    }
    if (filters.yearValueFilter) {
      params.set('year_value', filters.yearValueFilter);
    }
    if (filters.dateAddedMinFilter) {
      params.set('date_added_min', filters.dateAddedMinFilter);
    }
    if (filters.dateAddedMaxFilter) {
      params.set('date_added_max', filters.dateAddedMaxFilter);
    }
    if (filters.styleFilter.length > 0) {
      params.set('style_filter', filters.styleFilter.join(','));
    }
    if (filters.tagFilter.length > 0) {
      params.set('tag_filter', filters.tagFilter.join(','));
    }
    if (filters.selectedTags.length > 0) {
      params.set('tags', filters.selectedTags.join(','));
    }

    return params;
  };

  const fetchAllCollectionPages = async (
    styles: string[] = [],
    filterOverrides?: Partial<CollectionFilters>
  ): Promise<DiscogsRelease[]> => {
    const releases: DiscogsRelease[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const params = buildCollectionParams(styles, page, false, 100, filterOverrides);
      const response = await fetch(`/api/discogs?${params.toString()}`);

      if (!response.ok) {
        break;
      }

      const result = await response.json();
      if (result.error) {
        break;
      }

      releases.push(...(result.releases || []));
      totalPages = result.pagination?.pages || 1;
      page += 1;
    } while (page <= totalPages);

    return releases;
  };

  // Helper function to add line breaks for text longer than 50 characters
  const addLineBreaks = (text: string, maxLength: number = 50) => {
    if (text.length <= maxLength) {
      return text;
    }
    
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';
    
    for (const word of words) {
      if ((currentLine + word).length <= maxLength) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          // Single word longer than maxLength, keep it as is
          lines.push(word);
        }
      }
    }
    
    if (currentLine) {
      lines.push(currentLine);
    }
    
    return lines.join('\n');
  };

  const renderStyleChips = (
    styles: string[],
    maxVisible: number = 4,
    chipClassName: string = 'bg-secondary text-secondary-foreground'
  ) => {
    const uniqueStyles = Array.from(new Set(styles));
    const visibleLimit = uniqueStyles.length > maxVisible ? Math.max(1, maxVisible - 1) : maxVisible;
    const visibleStyles = uniqueStyles.slice(0, visibleLimit);
    const hiddenCount = Math.max(0, uniqueStyles.length - visibleStyles.length);

    return (
      <div className="flex h-14 flex-wrap content-start gap-1 overflow-hidden">
        {visibleStyles.map((style) => (
          <span
            key={style}
            className={`max-w-32 truncate rounded px-2 py-1 text-xs ${chipClassName}`}
            title={style}
          >
            {style}
          </span>
        ))}
        {hiddenCount > 0 && (
          <span
            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600"
            title={uniqueStyles.slice(visibleLimit).join(', ')}
          >
            +{hiddenCount} more
          </span>
        )}
      </div>
    );
  };

  // Note: Sorting is now handled server-side via API parameters

  // Function to handle column header click for sorting
  const handleSort = (column: string) => {
    const newSortColumn = column;
    let newSortDirection = sortDirection;
    
    if (sortColumn === column) {
      newSortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    }
    
    setSortColumn(newSortColumn);
    setSortDirection(newSortDirection);
    setCurrentPage(1); // Reset to first page when sorting changes
    
    // Fetch data with new sorting
    fetchCollection(selectedStyles, 1, includeDetails, undefined, undefined, {
      sortColumn: newSortColumn,
      sortDirection: newSortDirection,
    });
  };

  // Function to get Discogs URL for a release
  const getDiscogsUrl = (release: DiscogsRelease) => {
    const releaseId = release.basic_information.id;
    const url = `https://www.discogs.com/release/${releaseId}`;
    return isValidDiscogsUrl(url) ? url : '#';
  };

  // Function to get Discogs URL for a label
  const getDiscogsLabelUrl = (labelId: number) => {
    return `https://www.discogs.com/label/${labelId}`;
  };

  // Function to handle filter icon click
  const handleFilterClick = (column: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent sorting when clicking filter icon
    
    const rect = event.currentTarget.getBoundingClientRect();
    setFilterDropdownPosition({
      top: rect.bottom + 5,
      left: rect.left,
    });
    
    if (activeFilterColumn === column) {
      setActiveFilterColumn(null);
    } else {
      setActiveFilterColumn(column);
      // Focus the input after the dropdown opens
      setTimeout(() => {
        if (filterDropdownRef.current) {
          filterDropdownRef.current.focusInput();
        }
      }, 100);
    }
  };

  // Function to close filter dropdown
  const closeFilterDropdown = () => {
    setActiveFilterColumn(null);
  };

  // Function to apply filters
  const applyFilters = () => {
    closeFilterDropdown();
    setCurrentPage(1);

    window.setTimeout(() => {
      fetchCollection(selectedStyles, 1, includeDetails);
    }, 0);
  };

  // Function to check if a column has an active filter
  const hasActiveFilter = (column: string) => {
    switch (column) {
      case 'artist':
        return !!artistFilter;
      case 'title':
        return !!titleFilter;
      case 'label':
        return !!labelFilter;
      case 'year':
        return !!(yearMinFilter || yearMaxFilter || yearValueFilter);
      case 'styles':
        return styleFilter.length > 0;
      case 'tags':
        return tagFilter.length > 0;
      case 'date_added':
        return !!(dateAddedMinFilter || dateAddedMaxFilter);
      default:
        return false;
    }
  };

  // Function to clear a specific column filter
  const clearColumnFilter = (column: string) => {
    const clearedFilters: CollectionFilters = {
      searchFilter,
      artistFilter,
      titleFilter,
      labelFilter,
      yearMinFilter,
      yearMaxFilter,
      yearValueFilter,
      dateAddedMinFilter,
      dateAddedMaxFilter,
      styleFilter,
      tagFilter,
      selectedTags,
    };

    switch (column) {
      case 'artist':
        setArtistFilter('');
        clearedFilters.artistFilter = '';
        break;
      case 'title':
        setTitleFilter('');
        clearedFilters.titleFilter = '';
        break;
      case 'label':
        setLabelFilter('');
        clearedFilters.labelFilter = '';
        break;
      case 'year':
        setYearMinFilter('');
        setYearMaxFilter('');
        setYearValueFilter('');
        clearedFilters.yearMinFilter = '';
        clearedFilters.yearMaxFilter = '';
        clearedFilters.yearValueFilter = '';
        break;
      case 'styles':
        setStyleFilter([]);
        clearedFilters.styleFilter = [];
        break;
      case 'tags':
        setTagFilter([]);
        clearedFilters.tagFilter = [];
        break;
      case 'date_added':
        setDateAddedMinFilter('');
        setDateAddedMaxFilter('');
        clearedFilters.dateAddedMinFilter = '';
        clearedFilters.dateAddedMaxFilter = '';
        break;
    }

    setCurrentPage(1);
    closeFilterDropdown();
    window.setTimeout(() => {
      fetchCollection(selectedStyles, 1, includeDetails, undefined, clearedFilters);
    }, 0);
  };

  const fetchCollection = async (
    styles: string[] = [],
    page: number = 1,
    withDetails: boolean = includeDetails,
    customPerPage?: number,
    filterOverrides?: Partial<CollectionFilters>,
    sortOverrides?: { sortColumn?: string; sortDirection?: 'asc' | 'desc' }
  ) => {
    setIsCollectionLoading(true);
    setError(null);
    try {
      const params = buildCollectionParams(styles, page, withDetails, customPerPage, filterOverrides, sortOverrides);
      const url = `/api/discogs${params.toString() ? `?${params.toString()}` : ''}`;
      
      const response = await fetch(url);
      
      if (response.status === 429) {
        // Rate limit exceeded
        const retryAfter = response.headers.get('X-RateLimit-Reset-After');
        const retrySeconds = retryAfter ? parseInt(retryAfter) : 60;
        setError(`Rate limit exceeded. Please wait ${retrySeconds} seconds before trying again.`);
        return;
      }

      const result = await readJsonResponse(response);

      if (!response.ok) {
        if (result.code === SETUP_REQUIRED_CODE && result.setup) {
          setSetupStatus(result.setup);
          setError(null);
          return;
        }
        setError(result.message || result.error || 'Failed to fetch collection');
        return;
      }
      
      if (result.error) {
        setError(result.error);
      } else {
        console.log('Collection data received:', {
          releasesCount: result.releases?.length || 0,
          totalCollection: result.totalCollection,
          totalFiltered: result.totalFiltered,
          pagination: result.pagination,
        });
        setData(result);
        setCurrentPage(page);
        setIncludeDetails(Boolean(result.includeDetails));
        
        if (Array.isArray(result.availableStyles)) {
          setAllAvailableStyles(result.availableStyles);
        }
      }
    } catch (error) {
      console.error('Error fetching collection:', error);
      if (error instanceof Error && error.message === 'NON_JSON_RESPONSE') {
        setError('The server returned an unexpected error. Check the terminal for details.');
      } else {
        setError('Failed to fetch collection');
      }
    } finally {
      setIsCollectionLoading(false);
    }
  };

  const loadAllStyles = async () => {
    await fetchCollection([], 1, true);
  };

  const handleStyleSelectionChange = (newSelectedStyles: string[]) => {
    selectedStylesRef.current = newSelectedStyles;
    setSelectedStyles(newSelectedStyles);
    setCurrentPage(1);
    if (!styleFilterOpen) {
      fetchCollection(newSelectedStyles, 1, includeDetails);
    }
  };

  const handleStyleFilterOpenChange = (open: boolean) => {
    setStyleFilterOpen(open);
    if (!open) {
      fetchCollection(selectedStylesRef.current, 1, includeDetails);
    }
  };

  const handleTagSelectionChange = (newSelectedTags: string[]) => {
    selectedTagsRef.current = newSelectedTags;
    setSelectedTags(newSelectedTags);
    setCurrentPage(1);
    if (!tagFilterOpen) {
      fetchCollection(selectedStyles, 1, includeDetails, undefined, { selectedTags: newSelectedTags });
    }
  };

  const handleTagFilterOpenChange = (open: boolean) => {
    setTagFilterOpen(open);
    if (!open) {
      fetchCollection(selectedStyles, 1, includeDetails, undefined, {
        selectedTags: selectedTagsRef.current,
      });
    }
  };

  const patchReleaseTags = (releaseId: number, nextTags: CollectionTag[]) => {
    setData((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        releases: current.releases.map((release) => (
          release.basic_information.id === releaseId
            ? { ...release, tags: nextTags }
            : release
        )),
      };
    });
  };

  const handleAddReleaseTag = async (release: DiscogsRelease, name: string) => {
    try {
      const nextTags = await addTagToRelease(release.basic_information.id, name);
      patchReleaseTags(release.basic_information.id, nextTags);
    } catch (error) {
      console.error('Failed to add tag:', error);
      toast.error('Failed to add tag');
    }
  };

  const handleRemoveReleaseTag = async (release: DiscogsRelease, tagId: number) => {
    try {
      const nextTags = await removeTagFromRelease(release.basic_information.id, tagId);
      patchReleaseTags(release.basic_information.id, nextTags);
    } catch (error) {
      console.error('Failed to remove tag:', error);
      toast.error('Failed to remove tag');
    }
  };

  const clearFilters = () => {
    setSelectedStyles([]);
    setSelectedTags([]);
    setCurrentPage(1); // Reset to first page when clearing style filters
    fetchCollection([], 1, includeDetails, undefined, { selectedTags: [] });
  };

  const handlePageChange = (page: number) => {
    fetchCollection(selectedStyles, page, includeDetails);
  };

  const handleUpdateCollection = async () => {
    if (setupStatus && !setupStatus.configured) {
      toast.error('Configure Discogs API credentials in .env.local first');
      return;
    }

    try {
      const action = isUpdating ? 'stop' : 'trigger';
      const response = await fetch('/api/discogs/update-collection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, period: syncPeriod }),
      });

      const result = await readJsonResponse(response);

      if (result.code === SETUP_REQUIRED_CODE && result.setup) {
        setSetupStatus(result.setup);
        toast.error(result.message || 'Discogs API credentials are not configured');
      } else if (!response.ok || result.error) {
        toast.error(`Collection import failed: ${result.message || result.error || 'Unknown error'}`);
      } else if (result.job) {
        setUpdateOperation(result.job);
        void operationPollerRef.current?.start();
        if (action === 'stop') {
          toast.info('Collection import stop requested.');
        } else {
          operationRefreshPendingRef.current.update = true;
          const scope = syncPeriod === 'all' ? 'all time' : getCollectionSyncPeriodLabel(syncPeriod).toLowerCase();
          toast.success(`Collection import started for releases added within ${scope}.`);
        }
      } else {
        toast.error('Collection import did not return a job status.');
      }
    } catch (error) {
      console.error('Error updating collection:', error);
      toast.error('Failed to import collection changes');
    }
  };

  const handleSyncCollection = async () => {
    if (setupStatus && !setupStatus.configured) {
      toast.error('Configure Discogs API credentials in .env.local first');
      return;
    }

    setError(null);

    try {
      const action = isSyncing ? 'stop' : 'trigger';
      const response = await fetch('/api/discogs/database-sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action, period: syncPeriod }),
      });

      const result = await readJsonResponse(response);

      if (result.code === SETUP_REQUIRED_CODE && result.setup) {
        setSetupStatus(result.setup);
        toast.error(result.message || 'Discogs API credentials are not configured');
        return;
      }

      if (!response.ok || result.error) {
        toast.error('Release-detail refresh failed: ' + (result.message || result.error || 'Unknown error'));
        setError(result.error);
        return;
      }

      if (result.job) {
        setSyncOperation(result.job);
        void operationPollerRef.current?.start();
        if (action === 'stop') {
          toast.info('Release-detail refresh stop requested.');
        } else {
          operationRefreshPendingRef.current.sync = true;
          const scope = syncPeriod === 'all' ? 'all time' : getCollectionSyncPeriodLabel(syncPeriod).toLowerCase();
          toast.success(`Release-detail refresh started for releases added within ${scope}.`);
        }
      } else {
        toast.error('Release-detail refresh did not return a job status.');
      }
    } catch (error) {
      console.error('Error syncing collection:', error);
      toast.error('Failed to refresh release details');
      setError('Failed to refresh release details');
    }
  };

  const handleSyncPeriodChange = (period: CollectionSyncPeriod) => {
    setSyncPeriod(period);
    localStorage.setItem('collectionSyncPeriod', period);
  };


  const loadDetails = () => {
    fetchCollection(selectedStyles, currentPage, true);
  };

  // Function to start the background job
  const startJob = async (testMode: boolean = false, skipCache: boolean = false) => {
    try {
      const response = await fetch('/api/discogs/job', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ testMode, skipCache }),
      });

      const result = await response.json();
      
      if (result.error) {
        setError(result.error);
        return;
      }

      setJobStatus(prev => ({
        ...prev,
        id: result.jobId,
        status: 'pending',
        progress: 0,
        total: 0,
        processed: 0,
        startTime: new Date(),
        endTime: null,
        error: null,
        results: {
          videosLoaded: 0,
          pricesLoaded: 0,
          errors: 0
        }
      }));

      // Start polling for job status
      pollJobStatus(result.jobId);
      
    } catch (error) {
      console.error('Error starting job:', error);
      setError('Failed to start job');
    }
  };

  // Function to poll job status
  const pollJobStatus = async (jobId: string) => {
    const poll = async () => {
      try {
        const response = await fetch(`/api/discogs/job?jobId=${jobId}`);
        const result = await response.json();
        
        if (result.error) {
          console.error('Error polling job status:', result.error);
          return;
        }

        setJobStatus(prev => ({
          ...prev,
          status: result.status,
          progress: result.progress,
          total: result.total,
          processed: result.processed,
          startTime: new Date(result.startTime),
          endTime: result.endTime ? new Date(result.endTime) : null,
          error: result.error || null,
          results: result.results
        }));

        // Update rate limit status
        if (result.rateLimit) {
          setRateLimitStatus(result.rateLimit);
        }

        // Continue polling if job is still running
        if (result.status === 'running' || result.status === 'pending') {
          setTimeout(poll, 2000); // Poll every 2 seconds
        } else {
          // Job completed or failed, refresh collection data and sync cache
          if (result.status === 'completed') {
            // syncDatabase(); // Database sync handled automatically
            fetchCollection(selectedStyles, currentPage, includeDetails);
          }
        }
      } catch (error) {
        console.error('Error polling job status:', error);
      }
    };

    poll();
  };

  // Function to sync database (replaces cache sync)
  const syncDatabase = async () => {
    try {
      const response = await fetch('/api/discogs/database-sync?action=status');
      const result = await response.json();
      
      console.log('Database sync status:', result);
      
      if (result.job) {
        if (result.job.status === 'running') {
          toast.info(`Sync in progress: ${result.job.processed || 0}/${result.job.total || 0} releases processed`);
        } else if (result.job.status === 'completed') {
          toast.success('Database sync completed');
        } else if (result.job.status === 'failed') {
          toast.error(`Database sync failed: ${result.job.error || 'Unknown error'}`);
        } else {
          toast.info('Database sync is idle');
        }
      }
    } catch (error) {
      console.error('Error getting database sync status:', error);
      toast.error('Failed to check sync status');
    }
  };

  const loadReleaseDetails = async (releaseId: number) => {
    try {
      console.log(`Fetching release details for release ${releaseId}`);
      const response = await fetch(`/api/discogs/details?release_id=${releaseId}`);
      const result = await response.json();
      
      if (result.error) {
        console.error('Error fetching release details:', result.error);
        return;
      }
      
      const details = {
        videos: result.videos || [],
        tracklist: result.tracklist || [],
        priceInfo: result.priceInfo,
        media_condition: result.media_condition,
        sleeve_condition: result.sleeve_condition
      };
      
      setReleaseDetails(prev => ({
        ...prev,
        [releaseId]: details
      }));
      
      if (result.rateLimit) {
        setRateLimitStatus(result.rateLimit);
      }
    } catch (error) {
      console.error('Error fetching release details:', error);
    }
  };

  const clearAllFilters = () => {
    setSearchInput('');
    setSearchFilter('');
    setArtistFilter('');
    setTitleFilter('');
    setLabelFilter('');
    setYearMinFilter('');
    setYearMaxFilter('');
    setDateAddedMinFilter('');
    setDateAddedMaxFilter('');
    setYearValueFilter('');
    setStyleFilter([]);
    setTagFilter([]);
    setSelectedStyles([]);
    setSelectedTags([]);
    setCurrentPage(1); // Reset to first page when clearing all filters

    const clearedFilters: CollectionFilters = {
      searchFilter: '',
      artistFilter: '',
      titleFilter: '',
      labelFilter: '',
      yearMinFilter: '',
      yearMaxFilter: '',
      yearValueFilter: '',
      dateAddedMinFilter: '',
      dateAddedMaxFilter: '',
      styleFilter: [],
      tagFilter: [],
      selectedTags: [],
    };

    window.setTimeout(() => {
      fetchCollection([], 1, includeDetails, undefined, clearedFilters);
    }, 0);
  };

  const handleStyleFilterChange = (newStyleFilter: string[]) => {
    setStyleFilter(newStyleFilter);
  };

  const handleCollectionSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const nextSearchFilter = searchInput.trim();
    if (nextSearchFilter === searchFilter) {
      return;
    }

    const nextFilters: CollectionFilters = {
      ...getActiveFilters(),
      searchFilter: nextSearchFilter,
    };

    setSearchInput(nextSearchFilter);
    setSearchFilter(nextSearchFilter);
    setCurrentPage(1);
    fetchCollection(selectedStyles, 1, includeDetails, undefined, nextFilters);
  };

  const clearCollectionSearch = () => {
    const hadActiveSearch = Boolean(searchFilter);
    setSearchInput('');
    setSearchFilter('');

    if (!hadActiveSearch) {
      return;
    }

    const nextFilters: CollectionFilters = {
      ...getActiveFilters(),
      searchFilter: '',
    };

    setCurrentPage(1);
    fetchCollection(selectedStyles, 1, includeDetails, undefined, nextFilters);
  };

  const handleCollectionSearchInputChange = (value: string) => {
    setSearchInput(value);

    if (!value && searchFilter) {
      clearCollectionSearch();
    }
  };

  const handleRowsPerPageChange = (newRowsPerPage: number) => {
    setRowsPerPage(newRowsPerPage);
    setCurrentPage(1); // Reset to first page when changing rows per page
    fetchCollection(selectedStyles, 1, includeDetails, newRowsPerPage); // Fetch with new rows per page
  };

  // Function to get condition from database fields
  const getCondition = (release: DiscogsRelease) => {
    const details = releaseDetails[release.basic_information.id];
    return { 
      media: details?.media_condition || release.media_condition || 'Unknown', 
      sleeve: details?.sleeve_condition || release.sleeve_condition || 'Unknown' 
    };
  };

  // Function to categorize videos into playlists and individual videos
  const categorizeVideos = (videos: Array<{ uri: string; title: string; description: string; duration: number; embed: boolean }>) => {
    const playlists = new Map<string, { id: string; videos: Array<{ uri: string; title: string; description: string; duration: number; embed: boolean }> }>();
    const individualVideos: Array<{ uri: string; title: string; description: string; duration: number; embed: boolean }> = [];

    videos.forEach(video => {
      const playlistId = extractYouTubePlaylistId(video.uri);
      if (playlistId) {
        if (!playlists.has(playlistId)) {
          playlists.set(playlistId, { id: playlistId, videos: [] });
        }
        playlists.get(playlistId)!.videos.push(video);
      } else {
        individualVideos.push(video);
      }
    });

    return { playlists: Array.from(playlists.values()), individualVideos };
  };

  // Function to create a release playlist from individual videos
  const createReleasePlaylist = (videos: Array<{ uri: string; title: string; description: string; duration: number; embed: boolean }>, releaseTitle: string) => {
    if (videos.length < 1) return null;
    
    // Extract video IDs
    const seenVideoIds = new Set<string>();
    const playableVideos = videos.filter(video => {
      const videoId = extractYouTubeVideoId(video.uri);
      if (!videoId || seenVideoIds.has(videoId)) return false;
      seenVideoIds.add(videoId);
      return true;
    });
    const videoIds = playableVideos.map(video => extractYouTubeVideoId(video.uri)).filter(id => id !== null);
    
    if (videoIds.length < 1) return null;
    
    return {
      videos: playableVideos,
      videoIds: videoIds,
      title: `${releaseTitle} - Complete Playlist`,
      totalVideos: playableVideos.length
    };
  };

  // Function to create a custom playlist from individual videos
  const createCustomPlaylist = (videos: Array<{ uri: string; title: string; description: string; duration: number; embed: boolean }>, releaseTitle: string) => {
    if (videos.length < 2) return null; // Only create playlist if there are multiple videos
    
    // Extract video IDs and create a custom playlist
    const videoIds = videos.map(video => extractYouTubeVideoId(video.uri)).filter(id => id !== null);
    
    if (videoIds.length < 2) return null; // Need at least 2 videos for a playlist
    
    // Create a custom playlist URL using the first video as the main video and others as playlist
    const mainVideoId = videoIds[0];
    const playlistVideos = videoIds.slice(1);
    
    return {
      id: `custom-${mainVideoId}-${playlistVideos.join(',')}`,
      videos: videos,
      customPlaylistUrl: `https://www.youtube.com/watch?v=${mainVideoId}&list=${playlistVideos.join(',')}`
    };
  };

  // Spinner component
  const Spinner = () => (
    <div className="flex items-center justify-center">
      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
    </div>
  );

  // Discogs-style Playlist Component
  const DiscogsStylePlaylistComponent = ({ discogsVideos, releaseTitle, isCardView = false }: { discogsVideos: Array<{ videoId: string; title: string; duration: string }>; releaseTitle: string; isCardView?: boolean }) => {
    const [currentVideoId, setCurrentVideoId] = useState<string | null>(discogsVideos[0]?.videoId || null);

    return (
      <div className="space-y-3">
        {/* Main embedded player */}
        {currentVideoId && (
          <iframe
            width={isCardView ? "100%" : "640"}
            height={isCardView ? "200" : "360"}
            src={`https://www.youtube.com/embed/${currentVideoId}`}
            title={discogsVideos.find(v => v.videoId === currentVideoId)?.title || 'Video'}
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="rounded border w-full"
          ></iframe>
        )}
        
        {/* Discogs-style video list (hidden in card view) */}
        {!isCardView && (
          <ul className="space-y-1">
            {discogsVideos.map((video, index) => (
              <li key={video.videoId}>
                <button
                  type="button"
                  onClick={() => setCurrentVideoId(video.videoId)}
                  className={`w-full flex items-center gap-3 p-2 rounded hover:bg-gray-100 transition-colors ${
                    currentVideoId === video.videoId ? 'bg-blue-50 border border-blue-200' : ''
                  }`}
                >
                  {/* Thumbnail */}
                  <img
                    src={`https://i.ytimg.com/vi/${video.videoId}/default.jpg`}
                    alt=""
                    width="60"
                    height="45"
                    loading="lazy"
                    className="rounded"
                  />

                  {/* Play/Pause Icon */}
                  <div className="flex-shrink-0">
                    {currentVideoId === video.videoId ? (
                      <svg aria-label="Pause" viewBox="0 0 1024 1024" className="w-4 h-4 text-blue-600" role="img">
                        <path d="M878 110v804q0 15-11 26t-26 11H549q-15 0-26-11t-11-26V110q0-15 11-26t26-11h292q15 0 26 11t11 26zm-512 0v804q0 15-11 26t-26 11H37q-15 0-26-11T0 914V110q0-15 11-26t26-11h292q15 0 26 11t11 26z"></path>
                      </svg>
                    ) : (
                      <svg aria-label="Play" viewBox="0 0 1024 1024" className="w-4 h-4 text-gray-600" role="img">
                        <path d="M791 530L32 951q-13 8-23 2t-9-20V91q0-14 9-20t23 2l759 421q13 8 13 18t-13 18z"></path>
                      </svg>
                    )}
                  </div>

                  {/* Title and Duration */}
                  <div className="flex-1 text-left">
                    <div className="text-sm font-medium text-gray-900">{video.title}</div>
                    <span className="text-xs text-gray-500">{video.duration}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const ReleasePlaylistControls = ({ release, compact = false }: { release: DiscogsRelease; compact?: boolean }) => {
    const releaseId = release.basic_information.id;
    const assignedPlaylists = playlists.filter((playlist) => playlist.releaseIds.includes(releaseId));

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {assignedPlaylists.length > 0 ? (
            assignedPlaylists.map((playlist) => (
              <Link
                key={playlist.id}
                href={`/playlists?playlist=${playlist.id}`}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-800 hover:bg-blue-100"
                title={`Open ${playlist.name}`}
              >
                <ListMusic className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{playlist.name}</span>
              </Link>
            ))
          ) : (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <ListMusic className="h-3.5 w-3.5" />
              No playlists
            </span>
          )}
        </div>

        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs font-medium hover:bg-accent">
            <ListMusic className="h-3.5 w-3.5" />
            {compact ? 'Add' : 'Manage playlists'}
          </summary>
          <div className="mt-2 min-w-48 space-y-2 rounded-md border bg-white p-2 shadow-sm">
            {playlists.length > 0 ? (
              playlists.map((playlist) => {
                const checked = playlist.releaseIds.includes(releaseId);

                return (
                  <label key={playlist.id} className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        void toggleReleaseInPlaylist(playlist.id, release)
                          .then(() => {
                            toast.success(
                              checked
                                ? `Removed from "${playlist.name}"`
                                : `Added to "${playlist.name}"`
                            );
                          })
                          .catch((error) => {
                            console.error('Failed to update playlist:', error);
                            toast.error('Failed to update playlist');
                          });
                      }}
                      className="h-4 w-4 rounded border-gray-300"
                    />
                    <span className="min-w-0 flex-1 truncate">{playlist.name}</span>
                  </label>
                );
              })
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">Create a playlist first.</p>
                <Button asChild variant="outline" size="sm" className="w-full">
                  <Link href="/playlists">Go to Playlists</Link>
                </Button>
              </div>
            )}
          </div>
        </details>
      </div>
    );
  };

  // Release Card Component
  const ReleaseCard = ({ release, backgroundColor = 'bg-white' }: { release: DiscogsRelease; backgroundColor?: string }) => {
    const releaseId = release.basic_information.id;
    const details = releaseDetails[releaseId];
    // Prefer release.videos if it has data, otherwise use details loaded from the server.
    const videos = (release.videos && release.videos.length > 0) ? release.videos : (details?.videos || []);
    const tracklist = (release.tracklist && release.tracklist.length > 0) ? release.tracklist : (details?.tracklist || []);
    const { playlists, individualVideos } = categorizeVideos(videos);
    const releasePlaylist = createReleasePlaylist(individualVideos, release.basic_information.title);
    const condition = {
      media: details?.media_condition || release.media_condition || 'Unknown',
      sleeve: details?.sleeve_condition || release.sleeve_condition || 'Unknown'
    };
    const priceInfo = details?.priceInfo || release.priceInfo;

    return (
      <Card className={`w-full ${backgroundColor} border-2 border-gray-300 shadow-md`}>
        <CardContent className="p-4">
          <div className="space-y-4">
            {/* Release Information Section */}
            <div className="bg-blue-50 p-3 rounded-lg border border-blue-200">
              <div className="flex gap-4">
                <div className="flex-1 min-w-0">
                  <div className="space-y-2">
                  {/* Title */}
                  <h3 className="font-semibold text-lg leading-tight">
                    <a
                      href={getDiscogsUrl(release)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800 hover:underline"
                    >
                      {release.basic_information.title}
                    </a>
                  </h3>
                  
                  {/* Artist */}
                  <p
                    className="line-clamp-2 min-h-10 text-sm font-medium leading-5 text-gray-700"
                    title={release.basic_information.artists.map(artist => artist.name).join(', ')}
                  >
                    {release.basic_information.artists.map(artist => artist.name).join(', ')}
                  </p>
                  
                  {/* Year */}
                  <div className="text-sm text-gray-600">
                    <span className="font-medium">Year:</span> {release.basic_information.year === 0 ? 'Unknown' : release.basic_information.year}
                  </div>

                  {/* Labels */}
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Labels:</div>
                    <div className="text-sm text-gray-600">
                      {Array.from(new Set(release.basic_information.labels.map(label => label.name))).join(', ')}
                    </div>
                  </div>

                  {/* Styles */}
                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Styles:</div>
                    {renderStyleChips(
                      release.basic_information.styles,
                      4,
                      'border border-blue-200 bg-blue-100 text-blue-800'
                    )}
                  </div>

                  <div>
                    <div className="text-sm font-medium text-gray-700 mb-1">Tag</div>
                    <TagPicker
                      assignedTags={release.tags || []}
                      vocabulary={tagVocabulary}
                      onAdd={(name) => handleAddReleaseTag(release, name)}
                      onRemove={(tagId) => handleRemoveReleaseTag(release, tagId)}
                      testId={`release-tag-picker-${release.basic_information.id}`}
                    />
                  </div>
                  </div>
                </div>
                
                {/* Cover Image on the right */}
                <div className="flex-shrink-0">
                  {release.basic_information.cover_image ? (
                    <img
                      src={release.basic_information.cover_image}
                      alt={`${release.basic_information.title} cover`}
                      className="w-32 h-32 object-cover rounded"
                      onError={(e) => {
                        console.error('Failed to load cover image:', release.basic_information.cover_image);
                        e.currentTarget.style.display = 'none';
                      }}
                      onLoad={() => {
                        console.log('Successfully loaded cover image:', release.basic_information.cover_image);
                      }}
                    />
                  ) : (
                    <div className="w-32 h-32 bg-muted rounded flex items-center justify-center">
                      <span className="text-xs text-muted-foreground">No Image</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-blue-200 bg-white p-3">
              <div className="mb-2 text-xs font-medium text-gray-700">Collection Playlists:</div>
              <ReleasePlaylistControls release={release} />
            </div>

            {/* Tracklist */}
            <div className="mt-10">
              <div className="text-xs text-muted-foreground mb-2">Tracklist:</div>
              <div className="space-y-1 h-24 overflow-y-auto bg-gray-50 p-2 rounded border">
                {tracklist && tracklist.length > 0 ? (
                  tracklist.map((track, index) => (
                    <div key={index} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-500 font-mono w-6 flex-shrink-0">{track.position || `${index + 1}.`}</span>
                      <span className="flex-1">{track.title}</span>
                      {track.duration && (
                        <span className="text-gray-500 text-xs">{track.duration}</span>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="text-xs text-muted-foreground text-center py-2">No tracklist available</div>
                )}
              </div>
            </div>

            {/* Condition, Price, and Date Added Section */}
            <div className="bg-green-50 p-3 rounded-lg border border-green-200">
              <div className="grid grid-cols-3 gap-4">
                {/* Condition Section */}
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Condition:</div>
                  <div className="space-y-1">
                    <div className="text-sm">
                      <span className="text-purple-600">Media: {condition.media}</span>
                    </div>
                    <div className="text-sm">
                      <span className="text-orange-600">Sleeve: {condition.sleeve}</span>
                    </div>
                  </div>
                </div>
                
                {/* Date Added Section */}
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Date Added:</div>
                  <div className="text-sm text-gray-600">
                    {new Date(release.date_added).toLocaleDateString()}
                  </div>
                </div>
                
                {/* Price Section */}
                {priceInfo && (
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">Lowest Price:</div>
                    <div className="text-sm font-medium text-green-600">
                      {priceInfo.lowest_price ? formatCurrency(priceInfo.lowest_price, priceInfo.currency) : 'N/A'}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* YouTube Videos */}
            <div>
              {/* Check if any videos are available */}
              {(() => {
                const hasDiscogsVideos = release.discogsVideos && release.discogsVideos.length > 0;
                const hasYouTubePlaylist = release.youtubePlaylistId && !release.discogsVideos;
                const hasReleasePlaylist = releasePlaylist && !release.youtubePlaylistId && !release.discogsVideos;
                const hasYouTubeVideo = release.youtubeVideoId && !release.youtubePlaylistId && !releasePlaylist && !release.discogsVideos;
                const hasApiPlaylists = playlists.length > 0;
                if (hasDiscogsVideos || hasYouTubePlaylist || hasReleasePlaylist || hasYouTubeVideo || hasApiPlaylists) {
                  // Count only videos rendered by the embedded player/list.
                  const totalVideos = releasePlaylist?.videos.length || release.discogsVideos?.length ||
                    (hasYouTubePlaylist ? 1 : 0) +
                    (hasYouTubeVideo ? 1 : 0) +
                    playlists.length;

                  return (
                    <details className="bg-gray-50 rounded border">
                      <summary className="cursor-pointer select-none px-3 py-2 text-sm font-semibold text-gray-800">
                        Videos ({totalVideos})
                      </summary>
                      <div className="space-y-3 p-2 border-t">
                      {/* Discogs Videos */}
                      {hasDiscogsVideos && release.discogsVideos && (
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-gray-700">Discogs Videos:</div>
                          {release.discogsVideos.map((video, index) => (
                            <a
                              key={video.videoId}
                              href={isValidYouTubeUrl(`https://www.youtube.com/watch?v=${video.videoId}`) ? `https://www.youtube.com/watch?v=${video.videoId}` : '#'}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                              title={video.title}
                            >
                              🎵 {video.title.length > 70 ? video.title.substring(0, 70) + '...' : video.title} ({video.duration})
                            </a>
                          ))}
                        </div>
                      )}
                      
                      {/* YouTube Playlist */}
                      {hasYouTubePlaylist && release.youtubePlaylistId && (
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-gray-700">YouTube Playlist:</div>
                          <a
                            href={isValidYouTubeUrl(`https://www.youtube.com/playlist?list=${release.youtubePlaylistId}`) ? `https://www.youtube.com/playlist?list=${release.youtubePlaylistId}` : '#'}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                          >
                            📺 Full Album Playlist
                          </a>
                        </div>
                      )}
                      
                      {hasReleasePlaylist && releasePlaylist && (
                        <ReleasePlaylistComponent
                          playlist={releasePlaylist}
                          releaseTitle={release.basic_information.title}
                          isCardView
                        />
                      )}

                      {/* Single YouTube Video */}
                      {hasYouTubeVideo && release.youtubeVideoId && (
                        <div className="space-y-1">
                          <div className="text-xs font-medium text-gray-700">YouTube Video:</div>
                          <a
                            href={`https://www.youtube.com/watch?v=${release.youtubeVideoId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                          >
                            🎵 {release.basic_information.title.length > 70 ? release.basic_information.title.substring(0, 70) + '...' : release.basic_information.title} - From Discogs
                          </a>
                        </div>
                      )}
                      
                      {/* API Playlists */}
                      {hasApiPlaylists && playlists.map((playlist, index) => (
                        <div key={`api-playlist-${index}`} className="space-y-1">
                          <div className="text-xs font-medium text-gray-700">Playlist:</div>
                          <a
                            href={`https://www.youtube.com/playlist?list=${playlist.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                          >
                            📺 {(playlist.videos[0]?.title || 'Playlist').length > 70 ? (playlist.videos[0]?.title || 'Playlist').substring(0, 70) + '...' : (playlist.videos[0]?.title || 'Playlist')}
                          </a>
                        </div>
                      ))}
                      
                      </div>
                    </details>
                  );
                } else {
                  return (
                    <div className="text-sm text-muted-foreground text-center py-2">
                      No videos
                    </div>
                  );
                }
              })()}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  };

  // Release Playlist Component - Shows all videos from a release
  const ReleasePlaylistComponent = ({ playlist, releaseTitle, isCardView = false }: { playlist: { videos: Array<{ uri: string; title: string; description: string; duration: number; embed: boolean }>; videoIds: string[]; title: string; totalVideos: number }; releaseTitle: string; isCardView?: boolean }) => {
    const [currentIndex, setCurrentIndex] = useState(0);
    const [autoplay, setAutoplay] = useState(false);
    const currentVideoId = playlist.videoIds[currentIndex];
    const embedUrl = buildYouTubeEmbedUrl(
      currentVideoId ? [currentVideoId] : [],
      null,
      autoplay
    );

    return (
      <div className="space-y-2">
        {embedUrl && (
          <iframe
            width={isCardView ? "100%" : "640"}
            height={isCardView ? "200" : "360"}
            src={embedUrl}
            title={`${releaseTitle} videos`}
            frameBorder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="rounded border w-full"
          />
        )}

        <div className="max-h-36 overflow-y-auto bg-white rounded border divide-y">
          {playlist.videos.map((video, index) => (
            <button
              key={`${playlist.videoIds[index] || video.uri}-${index}`}
              type="button"
              onClick={() => {
                setCurrentIndex(index);
                setAutoplay(true);
              }}
              className={`w-full flex items-center gap-2 p-2 text-left ${currentIndex === index ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
            >
              {playlist.videoIds[index] && (
                <img
                  src={`https://i.ytimg.com/vi/${playlist.videoIds[index]}/default.jpg`}
                  alt=""
                  width="64"
                  height="40"
                  loading="lazy"
                  className="h-10 w-16 object-cover rounded"
                />
              )}
              <span className="min-w-0 flex-1 text-xs text-blue-700 truncate">{video.title}</span>
              {video.duration > 0 && <span className="text-[11px] text-gray-500">{formatYouTubeDuration(video.duration)}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  };

  // Job status component
  const JobStatusDisplay = () => {
    if (jobStatus.status === 'idle') return null;

    const getStatusColor = () => {
      switch (jobStatus.status) {
        case 'pending': return 'text-yellow-600';
        case 'running': return 'text-blue-600';
        case 'completed': return 'text-green-600';
        case 'failed': return 'text-red-600';
        default: return 'text-gray-600';
      }
    };

    const getStatusIcon = () => {
      switch (jobStatus.status) {
        case 'pending': return '⏳';
        case 'running': return '🔄';
        case 'completed': return '✅';
        case 'failed': return '❌';
        default: return '📊';
      }
    };

    const formatDuration = (startTime: Date, endTime: Date | null) => {
      const end = endTime || new Date();
      const duration = Math.round((end.getTime() - startTime.getTime()) / 1000);
      if (duration < 60) return `${duration}s`;
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;
      return `${minutes}m ${seconds}s`;
    };

    return (
      <Card className="mb-4">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-lg">
            <span>{getStatusIcon()}</span>
            <span className={getStatusColor()}>
              Background Job {jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)}
            </span>
            {jobStatus.status === 'running' && <Spinner />}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="space-y-3">
            {/* Progress Bar */}
            {jobStatus.total > 0 && (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Progress: {jobStatus.processed} / {jobStatus.total}</span>
                  <span>{jobStatus.progress}%</span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div 
                    className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                    style={{ width: `${jobStatus.progress}%` }}
                  ></div>
                </div>
              </div>
            )}

            {/* Results */}
            <div className="grid grid-cols-4 gap-4 text-sm">
              <div className="text-center">
                <div className="font-semibold text-blue-600">{jobStatus.total}</div>
                <div className="text-muted-foreground">Total</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-green-600">{jobStatus.results.videosLoaded}</div>
                <div className="text-muted-foreground">Videos</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-purple-600">{jobStatus.results.pricesLoaded}</div>
                <div className="text-muted-foreground">Prices</div>
              </div>
              <div className="text-center">
                <div className="font-semibold text-red-600">{jobStatus.results.errors}</div>
                <div className="text-muted-foreground">Errors</div>
              </div>
            </div>

            {/* Duration */}
            {jobStatus.startTime && (
              <div className="text-sm text-muted-foreground">
                Duration: {formatDuration(jobStatus.startTime, jobStatus.endTime)}
              </div>
            )}

            {/* Error Message */}
            {jobStatus.error && (
              <div className="text-sm text-red-600 bg-red-50 p-2 rounded">
                Error: {jobStatus.error}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  // Keep the selected page size when switching views; both views use the same options.
  const handleViewModeChange = (newViewMode: 'table' | 'cards') => {
    setViewMode(newViewMode);
    
    // Save view mode to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem('collectionViewMode', newViewMode);
    }
    
    let nextSortColumn = sortColumn;
    let nextSortDirection = sortDirection;
    
    if (newViewMode === 'cards') {
      // Set default sorting for card view: date added, descending
      nextSortColumn = 'date_added';
      nextSortDirection = 'desc';
      setSortColumn(nextSortColumn);
      setSortDirection(nextSortDirection);
    } else {
      // Set default sorting for table view: title, ascending
      nextSortColumn = 'title';
      nextSortDirection = 'asc';
      setSortColumn(nextSortColumn);
      setSortDirection(nextSortDirection);
    }
    
    // Reset to the first page while preserving the selected page size.
    setCurrentPage(1);
    
    // Fetch data with new view mode and page size
    fetchCollection(selectedStyles, 1, includeDetails, rowsPerPage, undefined, {
      sortColumn: nextSortColumn,
      sortDirection: nextSortDirection,
    });
  };

  const CollectionPagination = () => {
    const totalPages = data?.pagination?.pages || 1;
    const page = data?.pagination?.page || currentPage;

    const goToPage = (newPage: number) => {
      setCurrentPage(newPage);
      fetchCollection(selectedStyles, newPage, includeDetails);
    };

    return (
      <div className="flex items-center gap-4">
        <div className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(1)}
            disabled={currentPage === 1}
          >
            First
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(Math.max(1, currentPage - 1))}
            disabled={currentPage === 1}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(Math.min(totalPages, currentPage + 1))}
            disabled={currentPage === totalPages}
          >
            Next
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(totalPages)}
            disabled={currentPage === totalPages}
          >
            Last
          </Button>
        </div>
      </div>
    );
  };

  // Note: Pagination is now handled server-side via API parameters

  useEffect(() => {
    const savedViewMode = localStorage.getItem('collectionViewMode');
    if (savedViewMode === 'cards') {
      setViewMode('cards');
    } else if (savedViewMode === 'table') {
      setViewMode('table');
    }

    setHasLoadedViewPreferences(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadSetupStatus = async () => {
      try {
        const response = await fetch('/api/setup');
        if (!response.ok) {
          return;
        }
        const result = await readJsonResponse(response);
        if (!cancelled) {
          setSetupStatus(result);
        }
      } catch (error) {
        console.error('Error loading setup status:', error);
      }
    };

    loadSetupStatus();

    return () => {
      cancelled = true;
    };
  }, []);

  // Load all styles when component mounts
  useEffect(() => {
    if (!hasLoadedViewPreferences) return;

    loadAllStyles();
  }, [hasLoadedViewPreferences]);

  useEffect(() => {
    const savedPeriod = parseCollectionSyncPeriod(localStorage.getItem('collectionSyncPeriod'));
    if (savedPeriod) {
      setSyncPeriod(savedPeriod);
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    const refreshAfterOperation = () => {
      void fetchCollection(selectedStylesRef.current, 1, includeDetails);
    };

    const handleSyncCompletion = (job: DiscogsOperationJob) => {
      if (!operationRefreshPendingRef.current.sync || job.status === 'running' || job.status === 'idle') {
        return;
      }

      operationRefreshPendingRef.current.sync = false;
      if (job.status === 'completed') {
        const updated = job.results?.releasesUpdated || 0;
        if (updated > 0) {
          toast.success(`Release details refreshed for ${updated} releases.`);
        } else {
          toast.info('Release details and prices are already up to date.');
        }
      } else if (job.status === 'stopped') {
        toast.info('Release-detail refresh stopped.');
      } else {
        toast.error(`Release-detail refresh failed: ${job.error || 'Unknown error'}`);
      }
      refreshAfterOperation();
    };

    const handleUpdateCompletion = (job: DiscogsOperationJob) => {
      if (!operationRefreshPendingRef.current.update || job.status === 'running' || job.status === 'idle') {
        return;
      }

      operationRefreshPendingRef.current.update = false;
      if (job.status === 'completed') {
        toast.success(
          `Collection imported: ${job.results?.newReleases || 0} new releases, ${job.results?.conditionsUpdated || 0} conditions updated, ${job.results?.removedReleases || 0} removed.`,
        );
      } else if (job.status === 'stopped') {
        toast.info('Collection import stopped.');
      } else {
        toast.error(`Collection import failed: ${job.error || 'Unknown error'}`);
      }
      refreshAfterOperation();
    };

    const poller = createOperationStatusPoller({
      intervalMs: 2000,
      poll: async () => {
        let syncStatus: string | null = null;
        let updateStatus: string | null = null;

        try {
          const [syncResponse, updateResponse] = await Promise.all([
            fetch('/api/discogs/database-sync?action=status'),
            fetch('/api/discogs/update-collection?action=status'),
          ]);
          const [syncResult, updateResult] = await Promise.all([
            readJsonResponse(syncResponse),
            readJsonResponse(updateResponse),
          ]);

          if (disposed) {
            return { syncStatus, updateStatus };
          }

          if (syncResult.job) {
            const job = syncResult.job as DiscogsOperationJob;
            syncStatus = job.status;
            setSyncOperation(job);
            if (job.status === 'running' && job.period) {
              setSyncPeriod(job.period);
              localStorage.setItem('collectionSyncPeriod', job.period);
            }
            handleSyncCompletion(job);
          }

          if (updateResult.job) {
            const job = updateResult.job as DiscogsOperationJob;
            updateStatus = job.status;
            setUpdateOperation(job);
            if (job.status === 'running' && job.period) {
              setSyncPeriod(job.period);
              localStorage.setItem('collectionSyncPeriod', job.period);
            }
            handleUpdateCompletion(job);
          }
        } catch (pollError) {
          if (!disposed) {
            console.error('Error polling Discogs operation status:', pollError);
          }
          throw pollError;
        }

        return { syncStatus, updateStatus };
      },
    });

    operationPollerRef.current = poller;
    void poller.start();

    return () => {
      disposed = true;
      operationPollerRef.current = null;
      poller.dispose();
    };
  }, [includeDetails]);

  // Check for legacy browser cache on component mount
  useEffect(() => {
    // Only load cache stats to show "Clear Browser Cache" button if legacy data exists
    // We no longer use browser cache since all data is in server database
    const stats = getCacheStats();
    setCacheStats(stats);
    
    if (stats.totalCached > 0) {
      console.log(`Found ${stats.totalCached} releases in legacy browser cache (${stats.cacheSize})`);
      console.log('Consider clearing browser cache - all data is now in server database');
    }
  }, []);

  // Find release across all pages and navigate to it when coming from logs
  useEffect(() => {
    const releaseIdParam = searchParams.get('releaseId');
    if (!releaseIdParam || !data?.releases) {
      searchingReleaseIdRef.current = null;
      return;
    }

    const releaseId = Number.parseInt(releaseIdParam, 10);
    if (!Number.isFinite(releaseId) || releaseId <= 0) {
      return;
    }

    if (searchedReleaseIdsRef.current.has(releaseId)) {
      return;
    }
      
      // First, check if the release is on the current page
      const releaseOnCurrentPage = data.releases.find(
        (release: DiscogsRelease) => release.basic_information.id === releaseId
      );
      
      if (releaseOnCurrentPage) {
        // Release is on current page, scroll to it
        setTimeout(() => {
          const releaseElement = document.querySelector(`[data-release-id="${releaseId}"]`);
          if (releaseElement) {
            releaseElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            releaseElement.classList.add('ring-4', 'ring-blue-500', 'ring-opacity-50');
            setTimeout(() => {
              releaseElement.classList.remove('ring-4', 'ring-blue-500', 'ring-opacity-50');
            }, 3000);
          }
        }, 100);
        searchedReleaseIdsRef.current.add(releaseId);
      } else if (data.pagination && currentPage === 1) {
        // Release not on current page, search for it
        if (searchingReleaseIdRef.current === releaseId) {
          return;
        }

        searchingReleaseIdRef.current = releaseId;
        searchForRelease(releaseId).finally(() => {
          searchedReleaseIdsRef.current.add(releaseId);
          searchingReleaseIdRef.current = null;
        });
      }
  }, [searchParams, data?.releases, currentPage]);
  
  // Function to search for a release across all pages
  const searchForRelease = async (releaseId: number): Promise<boolean> => {
    try {
      const allReleases = await fetchAllCollectionPages(selectedStyles);
      const releaseIndex = allReleases.findIndex(
        (release: DiscogsRelease) => release.basic_information.id === releaseId
      );
      
      if (releaseIndex !== -1) {
        const targetPage = Math.ceil((releaseIndex + 1) / rowsPerPage);
        if (targetPage !== currentPage) {
          setCurrentPage(targetPage);
          fetchCollection(selectedStyles, targetPage, includeDetails, rowsPerPage);
        }
        return true;
      }
    } catch (error) {
      console.error('Error searching for release:', error);
    }
    return false;
  };

  // Note: Pagination reset is now handled server-side when filters/sorting change


  const discogsActionsDisabled = setupStatus?.configured === false;

  return (
    <div className="w-full">
      {setupStatus && !setupStatus.configured && (
        <div className="mb-4">
          <SetupRequiredCard setup={setupStatus} />
        </div>
      )}
      {/* Job Status Display */}
      <JobStatusDisplay />

      <div className="grid gap-4 lg:grid-cols-[288px_1fr]">
        <CollectionSidebar
          isCollectionLoading={isCollectionLoading}
          isSyncing={isSyncing}
          isUpdating={isUpdating}
          syncedReleaseCount={data?.pagination?.items || 0}
          cacheStats={cacheStats}
          onClearBrowserCache={() => {
            clearCache();
            setCacheStats({ totalCached: 0, cacheSize: '0 KB' });
          }}
          discogsActionsDisabled={discogsActionsDisabled}
          onSyncCollection={handleSyncCollection}
          onUpdateCollection={handleUpdateCollection}
          syncPeriod={syncPeriod}
          onSyncPeriodChange={handleSyncPeriodChange}
          allAvailableStyles={allAvailableStyles}
          selectedStyles={selectedStyles}
          onStyleSelectionChange={handleStyleSelectionChange}
          styleFilterOpen={styleFilterOpen}
          onStyleFilterOpenChange={handleStyleFilterOpenChange}
          allAvailableTags={tagVocabulary.map((tag) => tag.name)}
          selectedTags={selectedTags}
          onTagSelectionChange={handleTagSelectionChange}
          tagFilterOpen={tagFilterOpen}
          onTagFilterOpenChange={handleTagFilterOpenChange}
          showClearFilters={
            selectedStyles.length > 0 ||
            selectedTags.length > 0 ||
            Boolean(searchFilter || artistFilter || titleFilter || labelFilter || yearMinFilter || yearMaxFilter ||
              dateAddedMinFilter || dateAddedMaxFilter || yearValueFilter || styleFilter.length > 0 || tagFilter.length > 0)
          }
          onClearFilters={clearAllFilters}
        />

        <main className="min-w-0">
      <Card className="rounded-lg">
      <CardHeader className="px-4 sm:px-6">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>My Discogs Collection</CardTitle>
            <p className="text-sm text-muted-foreground">
                Filter your collection by music styles
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 sm:px-6">
        <div className="space-y-4">
            <div className="space-y-3 lg:hidden">
              <CollectionSyncPeriodSelect
                id="collection-sync-period-mobile"
                value={syncPeriod}
                onChange={handleSyncPeriodChange}
                disabled={isSyncing || isUpdating}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  data-testid="mobile-get-release-data"
                  onClick={handleSyncCollection}
                  disabled={discogsActionsDisabled || (isUpdating && !isSyncing)}
                >
                  {isSyncing ? 'Stop Refresh' : 'Refresh Details & Prices'}
                </Button>
                <Button
                  data-testid="mobile-update-collection"
                  variant="outline"
                  onClick={handleUpdateCollection}
                  disabled={discogsActionsDisabled || (isSyncing && !isUpdating)}
                >
                  {isUpdating ? 'Stop Import' : 'Import Releases & Conditions'}
                </Button>
              </div>
              <CollectionActionNotes />
                {/* Database info instead of browser cache */}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>💾 Database: {data?.pagination?.items || 0} releases synced</span>
                  {cacheStats.totalCached > 0 && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        clearCache();
                        // Update cache stats immediately so button disappears
                        setCacheStats({ totalCached: 0, cacheSize: '0 KB' });
                        console.log('Legacy browser cache cleared successfully');
                      }}
                      className="h-6 px-2 text-xs"
                      title="Clear legacy browser cache"
                    >
                      Clear Browser Cache ({cacheStats.totalCached})
                    </Button>
                  )}
                </div>
              {selectedStyles.length > 0 || selectedTags.length > 0 ? (
                <Button
                  variant="outline"
                  onClick={clearFilters}
                  disabled={isCollectionLoading}
                >
                  Clear Filters
                </Button>
              ) : null}
            </div>

            {error && (
              <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-lg">
                <p className="text-destructive text-sm">{error}</p>
              </div>
            )}

          {data && (
              <div className="space-y-4">
                {/* Original Style Filter (keeping for backward compatibility) */}
                <div className="space-y-2 lg:hidden">
                  <h3 className="text-sm font-medium">
                    Quick Style Filter:
                    {allAvailableStyles.length > 0 && (
                      <span className="text-muted-foreground ml-2">
                        ({allAvailableStyles.length} styles available)
                      </span>
                    )}
                  </h3>
                  {allAvailableStyles.length > 0 ? (
                    <StyleMultiSelect
                      styles={allAvailableStyles}
                      selectedStyles={selectedStyles}
                      onSelectionChange={handleStyleSelectionChange}
                      open={styleFilterOpen}
                      onOpenChange={handleStyleFilterOpenChange}
                      placeholder="Select styles to filter..."
                      className="w-full"
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {isCollectionLoading ? 'Loading styles...' : 'No styles available'}
                    </div>
                  )}
                </div>

                <div className="space-y-2 lg:hidden">
                  <h3 className="text-sm font-medium">
                    Quick Tag Filter:
                    {tagVocabulary.length > 0 && (
                      <span className="text-muted-foreground ml-2">
                        ({tagVocabulary.length} tags available)
                      </span>
                    )}
                  </h3>
                  {tagVocabulary.length > 0 ? (
                    <StyleMultiSelect
                      styles={tagVocabulary.map((tag) => tag.name)}
                      selectedStyles={selectedTags}
                      onSelectionChange={handleTagSelectionChange}
                      open={tagFilterOpen}
                      onOpenChange={handleTagFilterOpenChange}
                      placeholder="Select tags to filter..."
                      className="w-full"
                      testId="mobile-tag-filter"
                    />
                  ) : (
                    <div className="text-sm text-muted-foreground">
                      {isCollectionLoading ? 'Loading tags...' : 'No tags yet. Add them on a release.'}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                    {/* Filter Results Summary */}
                    {(() => {
                      const hasActiveFilters = searchFilter || artistFilter || titleFilter || labelFilter || yearMinFilter || yearMaxFilter ||
                                             dateAddedMinFilter || dateAddedMaxFilter || yearValueFilter ||
                                             styleFilter.length > 0 || tagFilter.length > 0 || selectedStyles.length > 0 || selectedTags.length > 0;
                      const isSorted = sortColumn !== 'date_added' || sortDirection !== 'desc';
                      
                      return (
                        <div className="text-sm text-muted-foreground" data-testid="collection-result-summary">
                          {hasActiveFilters ? (
                            <span>
                              Showing {data?.releases?.length || 0} of {data?.totalFiltered || 0} releases 
                              (filtered from {data?.totalCollection || 0} total)
                              {isSorted && ` • Sorted by ${sortColumn} ${sortDirection === 'asc' ? '↑' : '↓'}`}
                            </span>
                          ) : (
                            <span>
                              Showing {data?.releases?.length || 0} of {data?.totalFiltered || 0} releases (total: {data?.totalCollection || 0})
                              {isSorted && ` • Sorted by ${sortColumn} ${sortDirection === 'asc' ? '↑' : '↓'}`}
                            </span>
                          )}
                        </div>
                      );
                    })()}

                    <div className="space-y-4">
                      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-4">
                          <CollectionViewToggle viewMode={viewMode} onViewModeChange={handleViewModeChange} />
                          <CollectionRowsPerPageDropdown
                            viewMode={viewMode}
                            rowsPerPage={rowsPerPage}
                            onRowsPerPageChange={handleRowsPerPageChange}
                          />
                          {viewMode === 'cards' && (
                            <CollectionCardSortingControls
                              sortColumn={sortColumn}
                              sortDirection={sortDirection}
                              onSort={handleSort}
                            />
                          )}
                          <form
                            className="order-first flex w-full gap-2 sm:w-fit"
                            onSubmit={handleCollectionSearch}
                          >
                            <label className="sr-only" htmlFor="collection-search">
                              Search collection
                            </label>
                            <input
                              id="collection-search"
                              data-testid="collection-search-input"
                              type="search"
                              value={searchInput}
                              onChange={(event) => handleCollectionSearchInputChange(event.target.value)}
                              placeholder="Search artist, title, label, style, or genre"
                              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            />
                            <Button
                              type="submit"
                              data-testid="collection-search-submit"
                              disabled={isCollectionLoading}
                              className="h-8"
                            >
                              <Search className="size-4" aria-hidden="true" />
                              Search
                            </Button>
                            {(searchInput || searchFilter) && (
                              <Button
                                type="button"
                                variant="outline"
                                data-testid="collection-search-clear"
                                onClick={clearCollectionSearch}
                                disabled={isCollectionLoading}
                                className="h-8"
                              >
                                <X className="size-4" aria-hidden="true" />
                                Clear
                              </Button>
                            )}
                          </form>
                        </div>
                      </div>
                      <div className="flex justify-end">
                        <CollectionPagination />
                      </div>
                      {viewMode === 'table' ? (
                        <div className="border rounded-lg overflow-hidden">
                          <div className="overflow-x-auto">
                            <Table className="table-auto w-full" data-testid="collection-table">
                        <TableHeader className="sticky top-0 bg-background z-20 border-b">
                          <TableRow>
                            <TableHead className="whitespace-nowrap bg-background border-b">
                              <div className="flex items-center gap-1">
                                <span>Cover</span>
                                <span className="text-xs text-muted-foreground">📷</span>
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('artist')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Artist</span>
                                <span 
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('artist') 
                                      ? 'text-blue-600' 
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('artist', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('artist') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('artist');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                                {sortColumn === 'artist' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('title')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Title</span>
                                <span 
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('title') 
                                      ? 'text-blue-600' 
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('title', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('title') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('title');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                                {sortColumn === 'title' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('year')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Year</span>
                                <span 
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('year') 
                                      ? 'text-blue-600' 
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('year', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('year') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('year');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                                {sortColumn === 'year' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('label')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Label</span>
                                <span 
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('label') 
                                      ? 'text-blue-600' 
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('label', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('label') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('label');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                                {sortColumn === 'label' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b w-32 cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('styles')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Styles</span>
                                <span 
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('styles') 
                                      ? 'text-blue-600' 
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('styles', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('styles') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('styles');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                                {sortColumn === 'styles' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead className="whitespace-nowrap bg-background border-b w-56">
                              <div className="flex items-center gap-1">
                                <span>Tag</span>
                                <span
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('tags')
                                      ? 'text-blue-600'
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('tags', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('tags') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('tags');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('date_added')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Date Added</span>
                                <span 
                                  className={`text-xs cursor-pointer transition-colors ${
                                    hasActiveFilter('date_added') 
                                      ? 'text-blue-600' 
                                      : 'text-muted-foreground hover:text-blue-600'
                                  }`}
                                  onClick={(e) => handleFilterClick('date_added', e)}
                                >
                                  🔍
                                </span>
                                {hasActiveFilter('date_added') && (
                                  <button
                                    className="text-xs text-red-600 hover:text-red-800 ml-1"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clearColumnFilter('date_added');
                                    }}
                                    title="Clear filter"
                                  >
                                    ✕
                                  </button>
                                )}
                                {sortColumn === 'date_added' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('condition')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Condition</span>
                                <span className="text-xs text-purple-600">💿</span>
                                {sortColumn === 'condition' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b"
                            >
                              <div className="flex items-center gap-1">
                                <span>YouTube</span>
                                <span className="text-xs text-muted-foreground">🎵</span>
                              </div>
                            </TableHead>
                            <TableHead className="whitespace-nowrap bg-background border-b">
                              <div className="flex items-center gap-1">
                                <span>Playlists</span>
                                <ListMusic className="h-4 w-4 text-blue-700" />
                              </div>
                            </TableHead>
                            <TableHead 
                              className="whitespace-nowrap bg-background border-b cursor-pointer hover:bg-muted/50 transition-colors"
                              onClick={() => handleSort('lowest_price')}
                            >
                              <div className="flex items-center gap-1">
                                <span>Lowest Price</span>
                                <span className="text-xs text-green-600">💰</span>
                                {sortColumn === 'lowest_price' && (
                                  <span className="text-xs">
                                    {sortDirection === 'asc' ? '↑' : '↓'}
                                  </span>
                                )}
                              </div>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody className="max-h-96 overflow-y-auto">
                          {(data?.releases || []).map((release) => (
                            <TableRow 
                              key={release.id} 
                              data-testid={`release-row-${release.basic_information.id}`}
                              data-release-id={release.basic_information.id}
                              className="transition-all duration-300"
                            >
                              <TableCell className="whitespace-nowrap">
                                {release.basic_information.cover_image ? (
                                  <img
                                    src={release.basic_information.cover_image}
                                    alt={`${release.basic_information.title} cover`}
                                    className="w-12 h-12 object-cover rounded"
                                    onError={(e) => {
                                      console.error('Failed to load table cover image:', release.basic_information.cover_image);
                                      e.currentTarget.style.display = 'none';
                                    }}
                                  />
                                ) : (
                                  <div className="w-12 h-12 bg-muted rounded flex items-center justify-center">
                                    <span className="text-xs text-muted-foreground">No Image</span>
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className="font-medium">
                                <div className="whitespace-pre-line">
                                  {addLineBreaks(release.basic_information.artists
                                    .map(artist => artist.name)
                                    .join(', '))}
                                </div>
                              </TableCell>
                              <TableCell>
                                <a
                                  href={getDiscogsUrl(release)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-800 hover:underline transition-colors"
                                  title={`View "${release.basic_information.title}" on Discogs`}
                                >
                                  <div className="whitespace-pre-line">
                                    {addLineBreaks(release.basic_information.title)}
                                  </div>
                                </a>
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                {release.basic_information.year === 0 ? '-' : release.basic_information.year}
                              </TableCell>
                              <TableCell>
                                <div className="whitespace-pre-line break-words">
                                  {Array.from(new Set(release.basic_information.labels.map(label => label.name))).map((labelName, index) => (
                                    <span key={index}>
                                      {labelName}
                                      {index < Array.from(new Set(release.basic_information.labels.map(label => label.name))).length - 1 && ', '}
                                    </span>
                                  ))}
                                </div>
                              </TableCell>
                              <TableCell className="w-32">
                                {renderStyleChips(release.basic_information.styles, 5)}
                              </TableCell>
                              <TableCell className="min-w-56 align-top">
                                <TagPicker
                                  assignedTags={release.tags || []}
                                  vocabulary={tagVocabulary}
                                  compact
                                  onAdd={(name) => handleAddReleaseTag(release, name)}
                                  onRemove={(tagId) => handleRemoveReleaseTag(release, tagId)}
                                  testId={`table-tag-picker-${release.basic_information.id}`}
                                />
                              </TableCell>
                              <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                                {new Date(release.date_added).toLocaleDateString()}
                              </TableCell>
                              <TableCell className="text-sm whitespace-nowrap">
                                {(() => {
    const condition = getCondition(release);
                                  return (
                                    <div className="space-y-1">
                                      <div className="text-xs">
                                        <span className="text-muted-foreground">Media: </span>
                                        <span className="font-medium text-purple-600">{condition.media}</span>
                                      </div>
                                      <div className="text-xs">
                                        <span className="text-muted-foreground">Sleeve: </span>
                                        <span className="font-medium text-purple-600">{condition.sleeve}</span>
                                      </div>
                                    </div>
                                  );
                                })()}
                              </TableCell>
                              <TableCell className="w-70">
                                {(() => {
                                  const releaseId = release.basic_information.id;
                                  const details = releaseDetails[releaseId];
                                  // Prefer release.videos/tracklist if they have data
                                  const videos = (release.videos && release.videos.length > 0) ? release.videos : (details?.videos || []);
                                  const tracklist = (release.tracklist && release.tracklist.length > 0) ? release.tracklist : (details?.tracklist || []);
                                  
                                  const hasDiscogsVideos = release.discogsVideos && release.discogsVideos.length > 0;
                                  const hasYouTubePlaylist = release.youtubePlaylistId && !release.discogsVideos;
                                  const hasReleasePlaylist = videos.length > 0 && !release.youtubePlaylistId && !release.discogsVideos;
                                  const hasYouTubeVideo = release.youtubeVideoId && !release.youtubePlaylistId && !hasReleasePlaylist && !release.discogsVideos;

                                   const releasePlaylist = createReleasePlaylist(videos, release.basic_information.title);
                                   if (releasePlaylist) {
                                     return (
                                       <details className="bg-gray-50 rounded border">
                                         <summary className="cursor-pointer select-none px-2 py-1 text-sm font-semibold text-gray-800">
                                           Videos ({releasePlaylist.videos.length})
                                         </summary>
                                         <div className="p-2 border-t">
                                           <ReleasePlaylistComponent
                                             playlist={releasePlaylist}
                                             releaseTitle={release.basic_information.title}
                                             isCardView
                                           />
                                         </div>
                                       </details>
                                     );
                                   }

                                  if (hasDiscogsVideos || hasYouTubePlaylist || hasReleasePlaylist || hasYouTubeVideo) {
                                    // Count total videos for scrolling
                                    const totalVideos = (release.discogsVideos?.length || 0) + 
                                                      (hasYouTubePlaylist ? 1 : 0) + 
                                                      (hasYouTubeVideo ? 1 : 0) + 
                                                      videos.length;

                                    return (
                                      <div className={totalVideos > 8 ? "space-y-1 max-h-32 overflow-y-auto bg-gray-50 p-2 rounded border" : "space-y-1"}>
                                        {/* Discogs Videos */}
                                        {hasDiscogsVideos && release.discogsVideos && (
                                          <div className="space-y-1">
                                            <div className="text-xs font-medium text-gray-700">Discogs Videos:</div>
                                            {release.discogsVideos.map((video, index) => (
                                              <a
                                                key={video.videoId}
                                                href={`https://www.youtube.com/watch?v=${video.videoId}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                                                title={video.title}
                                              >
                                                🎵 {video.title.length > 70 ? video.title.substring(0, 70) + '...' : video.title} ({video.duration})
                                              </a>
                                            ))}
                                          </div>
                                        )}
                                        
                                        {/* YouTube Playlist */}
                                        {hasYouTubePlaylist && release.youtubePlaylistId && (
                                          <div className="space-y-1">
                                            <div className="text-xs font-medium text-gray-700">YouTube Playlist:</div>
                                            <a
                                              href={`https://www.youtube.com/playlist?list=${release.youtubePlaylistId}`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                                            >
                                              📺 Full Album Playlist
                                            </a>
                                          </div>
                                        )}
                                        
                                        {/* Release Videos */}
                                        {hasReleasePlaylist && videos.map((video, index) => (
                                          <a
                                            key={index}
                                            href={video.uri}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                                            title={video.title}
                                          >
                                            🎵 {video.title.length > 70 ? video.title.substring(0, 70) + '...' : video.title}
                                          </a>
                                        ))}
                                        
                                        {/* Single YouTube Video */}
                                        {hasYouTubeVideo && release.youtubeVideoId && (
                                          <div className="space-y-1">
                                            <div className="text-xs font-medium text-gray-700">YouTube Video:</div>
                                            <a
                                              href={`https://www.youtube.com/watch?v=${release.youtubeVideoId}`}
                                              target="_blank"
                                              rel="noopener noreferrer"
                                              className="text-blue-600 hover:text-blue-800 hover:underline text-sm block truncate"
                                            >
                                              🎵 {release.basic_information.title.length > 70 ? release.basic_information.title.substring(0, 70) + '...' : release.basic_information.title} - From Discogs
                                            </a>
                                          </div>
                                        )}
                                      </div>
                                    );
                                  } else {
                                    return <span className="text-muted-foreground">No videos</span>;
                                  }
                                })()}
                              </TableCell>
                              <TableCell className="min-w-56 align-top">
                                <ReleasePlaylistControls release={release} compact />
                              </TableCell>
                              <TableCell className="whitespace-nowrap">
                                {(() => {
                                  const releaseId = release.basic_information.id;
                                  const details = releaseDetails[releaseId];
                                  const priceInfo = details?.priceInfo || release.priceInfo;
                                  
                                  if (priceInfo) {
                                    return (
                                      <div className="text-sm">
                                        <span className="font-medium text-green-600">
                                          {priceInfo.lowest_price ? formatCurrency(priceInfo.lowest_price, priceInfo.currency) : 'N/A'}
                                        </span>
                                        <div className="text-xs text-muted-foreground">
                                          Lowest marketplace price
                                        </div>
                                      </div>
                                    );
                                  } else {
                                    return (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => loadReleaseDetails(releaseId)}
                                        className="h-6 px-2 text-xs"
                                      >
                                        Load Price
                                      </Button>
                                    );
                                  }
                                })()}
                              </TableCell>
                            </TableRow>
                          ))}
                          {(data?.releases?.length || 0) === 0 && (
                            <TableRow>
                              <TableCell colSpan={11} className="py-8 text-center text-muted-foreground">
                                No releases found matching the current filters
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                        </Table>
                        </div>
                      </div>
                      ) : (
                        /* Card View */
                        <div>
                          <div className="space-y-6">
                            {(() => {
                              const releases = data?.releases || [];
                              const cardsPerRow = 4;
                              const rows = [];
                              
                              for (let i = 0; i < releases.length; i += cardsPerRow) {
                                const rowReleases = releases.slice(i, i + cardsPerRow);
                                const isEvenRow = Math.floor(i / cardsPerRow) % 2 === 0;
                                
                                rows.push(
                                  <div 
                                    key={`row-${i}`}
                                    className={`grid grid-cols-1 gap-4 rounded-lg p-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 ${
                                      isEvenRow ? 'bg-gray-100' : 'bg-transparent'
                                    }`}
                                  >
                                    {rowReleases.map((release) => (
                                      <div 
                                        key={release.id} 
                                        className="flex transition-all duration-300" 
                                        data-release-id={release.basic_information.id}
                                      >
                                        <ReleaseCard 
                                          release={release} 
                                          backgroundColor={isEvenRow ? 'bg-gray-100' : 'bg-white'} 
                                        />
                                      </div>
                                    ))}
                                  </div>
                                );
                              }
                              
                              return rows;
                            })()}
                          </div>
                        </div>
                      )}
                      
                      {/* Bottom pagination controls */}
                      <div className="flex justify-between items-center">
                        <CollectionRowsPerPageDropdown
                          viewMode={viewMode}
                          rowsPerPage={rowsPerPage}
                          onRowsPerPageChange={handleRowsPerPageChange}
                        />
                        <CollectionPagination />
                      </div>
                    </div>

                    {/* Filter Dropdown */}
                    <FilterDropdown
                      ref={filterDropdownRef}
                      column={activeFilterColumn || ''}
                      isOpen={activeFilterColumn !== null}
                      onClose={closeFilterDropdown}
                      position={filterDropdownPosition}
                      artistFilter={artistFilter}
                      titleFilter={titleFilter}
                      labelFilter={labelFilter}
                      yearMinFilter={yearMinFilter}
                      yearMaxFilter={yearMaxFilter}
                      yearValueFilter={yearValueFilter}
                      dateAddedMinFilter={dateAddedMinFilter}
                      dateAddedMaxFilter={dateAddedMaxFilter}
                      styleFilter={styleFilter}
                      availableStyles={allAvailableStyles}
                      tagFilter={tagFilter}
                      availableTags={tagVocabulary.map((tag) => tag.name)}
                      onArtistFilterChange={setArtistFilter}
                      onTitleFilterChange={setTitleFilter}
                      onLabelFilterChange={setLabelFilter}
                      onYearMinFilterChange={setYearMinFilter}
                      onYearMaxFilterChange={setYearMaxFilter}
                      onYearValueFilterChange={setYearValueFilter}
                      onDateAddedMinFilterChange={setDateAddedMinFilter}
                      onDateAddedMaxFilterChange={setDateAddedMaxFilter}
                      onStyleFilterChange={setStyleFilter}
                      onTagFilterChange={setTagFilter}
                      onApplyFilters={applyFilters}
                      onClearFilters={clearAllFilters}
                    />

                  </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
        </main>
      </div>
    </div>
  );
}
