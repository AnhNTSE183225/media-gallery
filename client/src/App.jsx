import React, { useState, useEffect, useRef, memo } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { Play, Image as ImageIcon, Book, ArrowLeft, ArrowRight, X } from 'lucide-react';

const API_URL = 'http://localhost:3001/api';

// Configurable Navigation Keybinds (change these to your preference)
const NAV_KEYS = {
  previous: ['ArrowLeft', '1'],  // Keys for going backwards
  next: ['ArrowRight', '2'],     // Keys for going forward
  close: ['Escape']              // Keys for closing viewer
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

// Progress Bar Component
function ProgressBar({ current, total, currentItem }) {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  
  return (
    <div className="fixed bottom-6 right-6 bg-gray-800 text-white p-4 rounded-lg shadow-lg z-[200] animate-fade-in min-w-[300px]">
      <div className="mb-2 text-sm font-semibold">Scanning Library...</div>
      <div className="mb-2 text-xs text-gray-400 truncate">{currentItem || 'Starting...'}</div>
      <div className="w-full bg-gray-700 rounded-full h-2.5">
        <div 
          className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
          style={{ width: `${percentage}%` }}
        ></div>
      </div>
      <div className="mt-2 text-xs text-gray-300">{current} / {total} artists</div>
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
      <div className="aspect-[2/3] overflow-hidden bg-black flex items-center justify-center">
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
  const [scanProgress, setScanProgress] = useState(null);

  // Viewer State (derived from URL)
  const viewerIndex = searchParams.get('i') ? parseInt(searchParams.get('i')) : null;
  const storyPageIndex = searchParams.get('p') ? parseInt(searchParams.get('p')) : 0;

  const isFullscreen = viewerIndex !== null;

  // Sync Query with URL
  useEffect(() => {
    const q = searchParams.get('q');
    const text = searchParams.get('text');
    if (q !== null && q !== query) setQuery(q);
    if (text !== null && text !== textSearch) setTextSearch(text);
    const page = parseInt(searchParams.get('page')) || 1;
    fetchResults(q || '', text || '', page);
  }, [searchParams]);

  const fetchResults = async (tagQuery, textQuery, page) => {
    try {
      const res = await axios.get(`${API_URL}/search`, { params: { q: tagQuery, text: textQuery, page } });
      setItems(res.data.items || []);
      setTotalPages(res.data.pagination?.totalPages || 1);
    } catch (err) {
      console.error(err);
    }
  };

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
    try {
      // Show initial progress
      setScanProgress({ current: 0, total: 0, status: 'preparing', currentItem: 'Initializing...' });
      
      // Connect to SSE for progress updates FIRST
      const eventSource = new EventSource(`${API_URL}/scan/progress`);
      
      eventSource.onmessage = (event) => {
        const progress = JSON.parse(event.data);
        console.log('Progress update:', progress);
        
        if (progress.status === 'scanning') {
          setScanProgress(progress);
        } else if (progress.status === 'complete') {
          setScanProgress(null);
          setToast({ message: 'Scan complete! Refreshing results.', loading: false });
          eventSource.close();
          const page = parseInt(searchParams.get('page')) || 1;
          fetchResults(query, searchParams.get('text') || '', page);
        } else if (progress.status === 'error') {
          setScanProgress(null);
          setToast({ message: 'Scan failed', loading: false });
          eventSource.close();
        } else if (progress.status === 'idle') {
          // Initial connection, just keep showing preparing state
        }
      };
      
      eventSource.onerror = (err) => {
        console.error('SSE error:', err);
        eventSource.close();
        setScanProgress(null);
        setToast({ message: 'Connection error', loading: false });
      };
      
      // Wait a bit for SSE connection to establish
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Reset database and start scan
      await axios.post(`${API_URL}/reset`);
      await axios.post(`${API_URL}/scan`);
      
    } catch (err) {
      console.error('Scan error:', err);
      setToast({ message: 'Scan failed: ' + err.message, loading: false });
      setScanProgress(null);
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

  const closeViewer = () => {
    setSearchParams(prev => {
      const newParams = new URLSearchParams(prev);
      newParams.delete('i');
      newParams.delete('p');
      return newParams;
    });
  };

  const navigateViewer = (direction) => {
    if (viewerIndex === null) return;
    const currentItem = items[viewerIndex];

    // If inside a story, try to change pages first
    if (currentItem?.type === 'story') {
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
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.set('i', newIndex);
        newParams.set('p', '0'); // Reset page
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
          // Set to last possible item (approximate, refined by effect)
          newParams.set('i', 23); // Default limit - 1
          newParams.set('p', '0');
          return newParams;
        });
      }
    }
  };

  // Auto-correct Viewer Index if items change size (e.g. prev page has fewer items)
  useEffect(() => {
    if (items.length > 0 && viewerIndex !== null && viewerIndex >= items.length) {
      setSearchParams(prev => {
        const newParams = new URLSearchParams(prev);
        newParams.set('i', items.length - 1);
        return newParams;
      });
    }
  }, [items, viewerIndex]);

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!isFullscreen) return;
      if (NAV_KEYS.next.includes(e.key)) navigateViewer(1);
      if (NAV_KEYS.previous.includes(e.key)) navigateViewer(-1);
      if (NAV_KEYS.close.includes(e.key)) closeViewer();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen, viewerIndex, storyPageIndex, items]);

  // --- RENDERERS ---

  const currentItem = viewerIndex !== null ? items[viewerIndex] : null;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6 font-sans">

      {/* HEADER */}
      <div className="flex gap-4 mb-6">
        <button onClick={triggerScan} className="bg-blue-600 px-4 py-2 rounded hover:bg-blue-500">
          Rescan Library
        </button>
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          {/* Text Search (Artist/Name) */}
          <input
            type="text"
            name="text"
            value={textSearch}
            onChange={(e) => setTextSearch(e.target.value)}
            placeholder="Search Artist / Story Name..."
            className="w-1/3 p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
          />
          {/* Tag Search */}
          <input
            type="text"
            name="q"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags (e.g., SFW, CG)..."
            className="flex-1 p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
          />
          <button type="submit" className="hidden">Search</button>
        </form>
      </div>

      {/* GALLERY GRID */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {items.map((item, idx) => (
          <GalleryItem key={item.id} item={item} idx={idx} onOpen={openViewer} />
        ))}
      </div>

      {/* PAGINATION CONTROLS */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-4 mt-8 mb-4">
          <button
            onClick={() => handlePageChange((parseInt(searchParams.get('page')) || 1) - 1)}
            disabled={(parseInt(searchParams.get('page')) || 1) === 1}
            className="px-4 py-2 bg-gray-800 rounded disabled:opacity-50 hover:bg-gray-700"
          >
            Previous
          </button>
          <span className="text-gray-400">
            Page {parseInt(searchParams.get('page')) || 1} of {totalPages}
          </span>
          <button
            onClick={() => handlePageChange((parseInt(searchParams.get('page')) || 1) + 1)}
            disabled={(parseInt(searchParams.get('page')) || 1) === totalPages}
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
          <div className="absolute top-0 left-0 right-0 p-4 flex justify-between bg-gradient-to-b from-black/80 to-transparent z-20 pointer-events-none">
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
            onClick={(e) => { e.stopPropagation(); navigateViewer(-1); }}
          >
            <ArrowLeft size={32} />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 p-4 bg-white/10 hover:bg-white/20 rounded-full z-10"
            onClick={(e) => { e.stopPropagation(); navigateViewer(1); }}
          >
            <ArrowRight size={32} />
          </button>
        </div>
      )}
      
      {/* TOAST NOTIFICATIONS */}
      {toast && <Toast message={toast.message} loading={toast.loading} onClose={() => setToast(null)} />}
      
      {/* PROGRESS BAR */}
      {scanProgress && <ProgressBar current={scanProgress.current} total={scanProgress.total} currentItem={scanProgress.currentItem} />}
    </div>
  );
}
