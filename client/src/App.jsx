import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { Book, ArrowLeft, ArrowRight, X } from 'lucide-react';

const API_URL = 'http://localhost:3001/api';

const DEFAULT_APP_CONFIG = {
  itemsPerPage: 12,
  videoSkipSeconds: 3,
  keybinds: {
    previous: ['Digit1'],
    next: ['Digit2'],
    close: ['Escape']
  }
};

const DEFAULT_SCAN_STATUS = {
  status: 'idle',
  profile: '',
  processedArtists: 0,
  totalArtists: 0,
  percentage: 0,
  currentArtist: '',
  recentLogs: []
};

const normalizeKeyArray = (value, fallback) => {
  if (!Array.isArray(value)) return fallback;
  const keys = value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return keys.length > 0 ? keys : fallback;
};

const normalizeAppConfig = (rawConfig) => {
  const rawItemsPerPage = Number(rawConfig?.itemsPerPage);
  const rawVideoSkipSeconds = Number(rawConfig?.videoSkipSeconds);

  const itemsPerPage = Number.isFinite(rawItemsPerPage) && rawItemsPerPage > 0
    ? Math.floor(rawItemsPerPage)
    : DEFAULT_APP_CONFIG.itemsPerPage;

  const videoSkipSeconds = Number.isFinite(rawVideoSkipSeconds) && rawVideoSkipSeconds > 0
    ? rawVideoSkipSeconds
    : DEFAULT_APP_CONFIG.videoSkipSeconds;

  return {
    itemsPerPage,
    videoSkipSeconds,
    keybinds: {
      previous: normalizeKeyArray(rawConfig?.keybinds?.previous, DEFAULT_APP_CONFIG.keybinds.previous),
      next: normalizeKeyArray(rawConfig?.keybinds?.next, DEFAULT_APP_CONFIG.keybinds.next),
      close: normalizeKeyArray(rawConfig?.keybinds?.close, DEFAULT_APP_CONFIG.keybinds.close)
    }
  };
};

// Helper to construct media URL
const getMediaUrl = (path, thumbnail = false) => {
  const url = new URLSearchParams();
  url.set('path', path);
  if (thumbnail) url.set('thumbnail', 'true');
  return `${API_URL}/media?${url.toString()}`;
};

// Toast Component
function Toast({ message, loading, onClose }) {
  useEffect(() => {
    if (!loading) {
      const timer = setTimeout(onClose, 3000);
      return () => clearTimeout(timer);
    }
  }, [loading, onClose]);
  
  return (
    <div className="fixed bottom-6 right-6 bg-blue-600 text-white px-6 py-3 rounded-lg shadow-lg z-[200] animate-fade-in flex items-center gap-3">
      {loading && (
        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
      )}
      <span>{message}</span>
    </div>
  );
}

// Memoized Gallery Item Component with Intersection Observer
const GalleryItem = memo(({ item, idx, onOpen }) => {
  const thumbnailPath = item.type === 'story' ? item.pages[0] : item.path;
  const isVideo = thumbnailPath.match(/\.(mp4|webm|mkv|mov)$/i);
  const videoRef = useRef(null);
  const containerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '100px' } // Load when within 100px of viewport
    );
    
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    return () => observer.disconnect();
  }, []);
  
  const handleMouseEnter = () => {
    if (videoRef.current && isVisible) {
      videoRef.current.play().catch(() => {});
    }
  };
  
  const handleMouseLeave = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 1.0;
    }
  };
  
  return (
    <div
      ref={containerRef}
      onClick={() => onOpen(idx)}
      className="relative group cursor-pointer border border-gray-700 rounded overflow-hidden bg-gray-800"
    >
      <div className="aspect-[3/4] overflow-hidden bg-black flex items-center justify-center">
        {isVisible ? (
          isVideo ? (
            <video
              ref={videoRef}
              src={getMediaUrl(thumbnailPath) + "#t=1.0"}
              className="w-full h-full object-cover transition-transform group-hover:scale-105"
              muted
              loop
              playsInline
              preload="metadata"
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            />
          ) : (
            <img
              src={getMediaUrl(thumbnailPath, true)}
              alt={item.name}
              className="w-full h-full object-cover transition-transform group-hover:scale-105"
            />
          )
        ) : (
          <div className="w-full h-full bg-gray-800" />
        )}
      </div>
      <div className="p-2 text-sm">
        <p className="font-bold truncate text-blue-300">{item.artist}</p>
        <div className="flex justify-between items-center">
          <p className="truncate opacity-80">{item.name}</p>
          {item.type === 'story' && <Book size={14} className="text-yellow-500" />}
        </div>
        <div className="flex flex-wrap gap-1 mt-2">
          {item.tags && item.tags.map(tag => (
            <span key={tag} className="text-[10px] bg-gray-700 px-1.5 py-0.5 rounded text-gray-300">
              {tag}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
});

export default function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [textSearch, setTextSearch] = useState(searchParams.get('text') || '');
  const [items, setItems] = useState([]);
  const [totalPages, setTotalPages] = useState(1);
  const [toast, setToast] = useState(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [isRescanning, setIsRescanning] = useState(false);
  const [bootstrapError, setBootstrapError] = useState('');
  const [bootstrapRunId, setBootstrapRunId] = useState(0);
  const [appConfig, setAppConfig] = useState(DEFAULT_APP_CONFIG);
  const [scanStatus, setScanStatus] = useState(DEFAULT_SCAN_STATUS);
  const videoRef = useRef(null);
  
  // Profile Management State
  const [profiles, setProfiles] = useState([]);
  const [activeProfile, setActiveProfile] = useState('');

  // Viewer State (derived from URL)
  const viewerIndex = searchParams.get('i') ? parseInt(searchParams.get('i')) : null;
  const storyPageIndex = searchParams.get('p') ? parseInt(searchParams.get('p')) : 0;

  const isFullscreen = viewerIndex !== null;

  const fetchProfiles = async () => {
    try {
      const res = await axios.get(`${API_URL}/profiles`);
      setProfiles(res.data.profiles || []);
      setActiveProfile(res.data.activeProfile || '');
    } catch (err) {
      console.error('Error fetching profiles:', err);
    }
  };

  const fetchAppConfig = async () => {
    try {
      const res = await axios.get(`${API_URL}/app-config`);
      setAppConfig(normalizeAppConfig(res.data));
    } catch (err) {
      console.error('Failed to load app config from backend, using defaults:', err);
      setAppConfig(DEFAULT_APP_CONFIG);
    }
  };

  const fetchScanStatus = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/scan/status`);
      setScanStatus({
        ...DEFAULT_SCAN_STATUS,
        ...res.data,
        recentLogs: Array.isArray(res.data?.recentLogs) ? res.data.recentLogs : []
      });
    } catch {
      // Keep existing status on transient polling failures.
    }
  }, []);
  
  const switchProfile = async (profileName) => {
    setIsRescanning(true);

    try {
      setToast({ message: `Switching to ${profileName} and scanning...`, loading: true });
      await axios.post(`${API_URL}/profiles/switch`, { profileName });
      setActiveProfile(profileName);
      setToast({ message: `Switched to ${profileName}. Scan complete.`, loading: false });
      
      // Refresh results for new profile
      const page = parseInt(searchParams.get('page')) || 1;
      await fetchResults(query, searchParams.get('text') || '', page);
    } catch (err) {
      console.error('Error switching profile:', err);
      const errorMessage = err.response?.data?.error || 'Failed to switch profile';
      setToast({ message: errorMessage, loading: false });
    } finally {
      setIsRescanning(false);
    }
  };

  const fetchResults = useCallback(async (tagQuery, textQuery, page) => {
    try {
      const res = await axios.get(`${API_URL}/search`, {
        params: {
          q: tagQuery,
          text: textQuery,
          page,
          limit: appConfig.itemsPerPage
        }
      });
      setItems(res.data.items || []);
      setTotalPages(res.data.pagination?.totalPages || 1);
    } catch (err) {
      console.error(err);
    }
  }, [appConfig.itemsPerPage]);

  // Sync Query with URL
  useEffect(() => {
    if (isBootstrapping) return;

    const q = searchParams.get('q');
    const text = searchParams.get('text');
    setQuery(q || '');
    setTextSearch(text || '');
    const page = parseInt(searchParams.get('page')) || 1;
    fetchResults(q || '', text || '', page);
  }, [searchParams, isBootstrapping, fetchResults]);

  useEffect(() => {
    let isCancelled = false;

    const waitForBootstrap = async () => {
      while (!isCancelled) {
        const res = await axios.get(`${API_URL}/bootstrap-status`);
        const status = res.data?.status;

        if (status === 'ready') {
          return;
        }

        if (status === 'error') {
          throw new Error(res.data?.error || 'Startup sync failed');
        }

        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    };

    const initializeApp = async () => {
      try {
        setBootstrapError('');
        setIsBootstrapping(true);
        await Promise.all([waitForBootstrap(), fetchAppConfig()]);
        if (isCancelled) return;
        await fetchProfiles();
      } catch (err) {
        if (!isCancelled) {
          setBootstrapError(err.message || 'Failed to initialize application');
        }
      } finally {
        if (!isCancelled) {
          setIsBootstrapping(false);
        }
      }
    };

    initializeApp();

    return () => {
      isCancelled = true;
    };
  }, [bootstrapRunId]);

  useEffect(() => {
    if (!isBootstrapping && !isRescanning) return;

    let isCancelled = false;

    const run = async () => {
      if (!isCancelled) {
        await fetchScanStatus();
      }
    };

    run();
    const interval = setInterval(run, 800);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [isBootstrapping, isRescanning, fetchScanStatus]);

  const handleSearch = (e) => {
    e.preventDefault();
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      if (query) newParams.set('q', query); else newParams.delete('q');
      if (textSearch) newParams.set('text', textSearch); else newParams.delete('text');
      // Reset pagination/viewer on new search
      newParams.delete('i');
      newParams.delete('p');
      newParams.delete('page'); // Reset to page 1
      return newParams;
    });
  };

  const triggerScan = async () => {
    setIsRescanning(true);

    try {
      await axios.post(`${API_URL}/scan`);
      const page = parseInt(searchParams.get('page')) || 1;
      await fetchResults(query, searchParams.get('text') || '', page);
      setToast({ message: 'Scan complete! Results refreshed.', loading: false });
    } catch (err) {
      console.error('Scan error:', err);
      setToast({ message: 'Scan failed: ' + err.message, loading: false });
    } finally {
      setIsRescanning(false);
    }
  };

  const handlePageChange = (newPage) => {
    if (newPage < 1 || newPage > totalPages) return;
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.set('page', newPage);
      // Reset viewer
      newParams.delete('i');
      newParams.delete('p');
      return newParams;
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // --- NAVIGATION LOGIC ---

  const openViewer = (index) => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.set('i', index);
      newParams.set('p', '0');
      return newParams;
    });
  };

  const closeViewer = useCallback(() => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.delete('i');
      newParams.delete('p');
      return newParams;
    });
  }, [setSearchParams]);

  const navigateViewer = useCallback((direction, skipStory = false) => {
    if (viewerIndex === null) return;
    const currentItem = items[viewerIndex];

    // If inside a story and not skipping entire stories, try to change pages first
    if (currentItem?.type === 'story' && !skipStory) {
      const newPage = storyPageIndex + direction;
      if (newPage >= 0 && newPage < currentItem.pages.length) {
        setSearchParams(prev => {
          const newParams = new URLSearchParams(prev);
          newParams.set('p', newPage);
          return newParams;
        });
        return;
      }
    }

    // Otherwise, change Asset
    const newIndex = viewerIndex + direction;

    if (newIndex >= 0 && newIndex < items.length) {
      // Normal Navigation within page
      const nextItem = items[newIndex];
      const isGoingBack = direction < 0;
      
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.set('i', newIndex);
        // If skipping stories (Shift held), always go to first page
        // If normal navigation going back to a story, start at last page
        if (skipStory) {
          newParams.set('p', '0'); // Always first page when skipping stories
        } else if (nextItem?.type === 'story' && isGoingBack) {
          newParams.set('p', nextItem.pages.length - 1); // Last page when going back normally
        } else {
          newParams.set('p', '0'); // First page otherwise
        }
        return newParams;
      });
    } else if (newIndex >= items.length) {
      // Next Page?
      const currentPage = parseInt(searchParams.get('page')) || 1;
      if (currentPage < totalPages) {
        setSearchParams(prev => {
          const newParams = new URLSearchParams(prev);
          newParams.set('page', currentPage + 1);
          newParams.set('i', 0); // Start of new page
          newParams.set('p', '0');
          return newParams;
        });
      }
    } else if (newIndex < 0) {
      // Previous Page?
      const currentPage = parseInt(searchParams.get('page')) || 1;
      if (currentPage > 1) {
        setSearchParams(prev => {
          const newParams = new URLSearchParams(prev);
          newParams.set('page', currentPage - 1);
          // Use sentinel -1 so correction happens after the previous page has loaded.
          newParams.set('i', '-1');
          newParams.set('p', '0');
          return newParams;
        });
      }
    }
  }, [viewerIndex, items, storyPageIndex, searchParams, totalPages, setSearchParams]);

  // Auto-correct Viewer Index if items change size (e.g. prev page has fewer items)
  useEffect(() => {
    if (items.length > 0 && viewerIndex === -1) {
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.set('i', String(items.length - 1));
        return newParams;
      });
      return;
    }

    if (items.length > 0 && viewerIndex !== null && viewerIndex >= items.length) {
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.set('i', items.length - 1);
        return newParams;
      });
    }
  }, [items, viewerIndex, setSearchParams]);

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!isFullscreen) return;
      
      // For videos with arrow keys: custom seeking
      const videoElement = videoRef.current;
      const isArrowKey = e.code === 'ArrowLeft' || e.code === 'ArrowRight';
      
      if (videoElement && isArrowKey) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        
        const wasPlaying = !videoElement.paused;
        const skipAmount = e.code === 'ArrowRight'
          ? appConfig.videoSkipSeconds
          : -appConfig.videoSkipSeconds;
        const newTime = videoElement.currentTime + skipAmount;
        
        if (wasPlaying) {
          videoElement.pause();
        }
        
        if (videoElement.duration) {
          videoElement.currentTime = Math.max(0, Math.min(videoElement.duration, newTime));
        } else {
          videoElement.currentTime = Math.max(0, newTime);
        }
        
        if (wasPlaying) {
          videoElement.play().catch(() => {});
        }
        return;
      }
      
      // For all other keys, use navigation
      const skipStory = e.shiftKey;
      
      if (appConfig.keybinds.next.includes(e.code)) {
        e.preventDefault();
        navigateViewer(1, skipStory);
      }
      if (appConfig.keybinds.previous.includes(e.code)) {
        e.preventDefault();
        navigateViewer(-1, skipStory);
      }
      if (appConfig.keybinds.close.includes(e.code) || appConfig.keybinds.close.includes(e.key)) {
        closeViewer();
      }
    };
    // Use capture: true to intercept events before browser defaults
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isFullscreen, viewerIndex, storyPageIndex, items, appConfig, navigateViewer, closeViewer]);

  // --- RENDERERS ---

  const currentItem = viewerIndex !== null ? items[viewerIndex] : null;
  const currentPage = parseInt(searchParams.get('page')) || 1;

  if (isBootstrapping || isRescanning) {
    const loadingTitle = isRescanning ? 'Syncing profile' : 'Syncing library on startup';
    const recentLogs = scanStatus.recentLogs.slice(-8).reverse();
    const percentage = Number.isFinite(scanStatus.percentage) ? scanStatus.percentage : 0;

    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center p-6">
        <div className="w-full max-w-2xl bg-gray-800 border border-gray-700 rounded-xl p-6 text-center shadow-xl">
          <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <h1 className="text-lg font-semibold mb-2">{loadingTitle}</h1>
          <p className="text-sm text-gray-400 mb-3">
            {scanStatus.profile ? `Profile: ${scanStatus.profile}` : 'Preparing scan context...'}
          </p>
          <div className="w-full bg-gray-700 rounded-full h-2.5 mb-2 overflow-hidden">
            <div
              className="bg-blue-600 h-full transition-all duration-300"
              style={{ width: `${Math.max(0, Math.min(100, percentage))}%` }}
            ></div>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            {scanStatus.processedArtists} / {scanStatus.totalArtists} artists ({percentage}%)
          </p>
          {scanStatus.currentArtist && (
            <p className="text-sm text-blue-300 truncate mb-4">Current: {scanStatus.currentArtist}</p>
          )}
          {!isRescanning && bootstrapError ? (
            <>
              <p className="text-sm text-red-300 mb-4">{bootstrapError}</p>
              <button
                onClick={() => setBootstrapRunId(prev => prev + 1)}
                className="bg-blue-600 px-4 py-2 rounded hover:bg-blue-500"
              >
                Retry
              </button>
            </>
          ) : (
            <p className="text-sm text-gray-300">
              {isRescanning
                ? 'Please wait while the server rebuilds the selected profile index.'
                : 'Please wait while the server prepares your active profile.'}
            </p>
          )}
          {recentLogs.length > 0 && (
            <div className="mt-4 text-left">
              <p className="text-xs text-gray-400 mb-2">Recent logs</p>
              <div className="max-h-44 overflow-auto rounded border border-gray-700 bg-gray-900/70 p-2 text-xs font-mono text-gray-200">
                {recentLogs.map((line, index) => (
                  <div key={`${index}-${line}`} className="whitespace-pre-wrap break-words mb-1 last:mb-0">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 lg:p-5 font-sans">

      {/* HEADER */}
      <div className="mb-4">
        <div className="flex gap-3 mb-2">
          {/* Profile Selector */}
          {profiles.length > 0 && (
            <select 
              value={activeProfile} 
              onChange={(e) => switchProfile(e.target.value)}
              className="bg-gray-800 px-4 py-2 rounded border border-gray-700 hover:border-blue-500 focus:outline-none focus:border-blue-500 cursor-pointer"
            >
              {profiles.map(profile => (
                <option key={profile} value={profile}>{profile}</option>
              ))}
            </select>
          )}
          <button onClick={triggerScan} className="bg-blue-600 px-4 py-2 rounded hover:bg-blue-500">
            Rescan Library
          </button>
          <div className="flex-1 flex gap-2 min-w-0">
            <form onSubmit={handleSearch} className="flex-1 flex gap-2 min-w-0">
              {/* Text Search (Artist/Name) */}
              <input
                type="text"
                name="text"
                value={textSearch}
                onChange={(e) => setTextSearch(e.target.value)}
                placeholder="Search Artist / Story Name..."
                className="w-1/3 min-w-[180px] p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
              />
              {/* Tag Search */}
              <input
                type="text"
                name="q"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tags (e.g., tag1,tag2 | tag3|tag4 | -tag5)..."
                className="flex-1 min-w-0 p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
              />
              <button type="submit" className="hidden">Search</button>
            </form>

            {totalPages > 1 && (
              <div className="hidden lg:flex items-center gap-2 px-2 py-1 bg-gray-800 rounded border border-gray-700 whitespace-nowrap">
                <button
                  onClick={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-300 px-1">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  onClick={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  className="px-3 py-1.5 bg-gray-700 rounded disabled:opacity-50 hover:bg-gray-600"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
        
        {/* Search Help Text */}
        <div className="text-[11px] text-gray-500 ml-auto pl-24">
          <span className="font-semibold text-gray-400">Tag operators:</span> 
          <span className="ml-2"><code className="bg-gray-800 px-1 py-0.5 rounded">tag1,tag2</code> = AND (both required)</span>
          <span className="ml-3"><code className="bg-gray-800 px-1 py-0.5 rounded">tag1|tag2</code> = OR (at least one)</span>
          <span className="ml-3"><code className="bg-gray-800 px-1 py-0.5 rounded">-tag3</code> = NOT (exclude)</span>
        </div>
      </div>

      {/* GALLERY GRID */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 xl:grid-cols-8 2xl:grid-cols-9 gap-3">
        {items.map((item, idx) => (
          <GalleryItem key={item.id} item={item} idx={idx} onOpen={openViewer} />
        ))}
      </div>

      {/* PAGINATION CONTROLS */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-4 mt-8 mb-4">
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className="px-4 py-2 bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700"
          >
            Previous
          </button>
          <span className="text-gray-400">
            Page {currentPage} of {totalPages}
          </span>
          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            className="px-4 py-2 bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700"
          >
            Next
          </button>
        </div>
      )}

      {/* FULLSCREEN VIEWER */}
      {isFullscreen && currentItem && (
        <div className="fixed inset-0 bg-black z-[100] flex flex-col h-screen w-screen overflow-hidden">

          {/* Top Bar - Now absolute and fades out or stays on top */}
          <div className="absolute top-0 left-0 right-0 p-4 flex justify-between z-20 pointer-events-none">
            <div className="pointer-events-auto">
              <h2 className="text-xl font-bold text-white drop-shadow-md">{currentItem.artist} / {currentItem.name}</h2>
              {currentItem.type === 'story' && (
                <span className="text-yellow-400 text-sm font-semibold drop-shadow-md">
                  Page {storyPageIndex + 1} of {currentItem.pages.length}
                </span>
              )}
            </div>
            <button onClick={closeViewer} className="pointer-events-auto p-2 bg-black/40 rounded-full hover:bg-white/20 transition-colors">
              <X size={32} />
            </button>
          </div>

          {/* Main Content */}
          <div className="absolute inset-0 flex items-center justify-center p-4">
            {(() => {
              const pathToShow = currentItem.type === 'story'
                ? currentItem.pages[storyPageIndex]
                : currentItem.path;

              const isVideo = pathToShow.endsWith('.mp4') || pathToShow.endsWith('.webm');

              if (isVideo) {
                return (
                  <video
                    ref={videoRef}
                    src={getMediaUrl(pathToShow)}
                    controls
                    autoPlay
                    className="w-full h-full object-contain"
                  />
                );
              }
              return (
                <img
                  src={getMediaUrl(pathToShow)}
                  className="w-full h-full object-contain drop-shadow-2xl"
                />
              );
            })()}
          </div>

          {/* Navigation Overlay Hints */}
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 p-4 bg-white/10 hover:bg-white/20 rounded-full z-10"
            onClick={(e) => { e.stopPropagation(); navigateViewer(-1, e.shiftKey); }}
          >
            <ArrowLeft size={32} />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 p-4 bg-white/10 hover:bg-white/20 rounded-full z-10"
            onClick={(e) => { e.stopPropagation(); navigateViewer(1, e.shiftKey); }}
          >
            <ArrowRight size={32} />
          </button>
        </div>
      )}
      
      {/* TOAST NOTIFICATIONS */}
      {toast && <Toast message={toast.message} loading={toast.loading} onClose={() => setToast(null)} />}
    </div>
  );
}
