import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useSearchParams } from 'react-router-dom';
import { Play, Image as ImageIcon, Book, ArrowLeft, ArrowRight, X } from 'lucide-react';

const API_URL = 'http://localhost:3001/api';

// Helper to construct media URL
const getMediaUrl = (path) => `${API_URL}/media?path=${encodeURIComponent(path)}`;

export default function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get('q') || '');
  const [items, setItems] = useState([]);

  // Viewer State
  const [viewerIndex, setViewerIndex] = useState(null); // Index in the Search Results
  const [storyPageIndex, setStoryPageIndex] = useState(0); // Index inside a Story
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Sync Query with URL
  useEffect(() => {
    const q = searchParams.get('q');
    if (q) setQuery(q);
    fetchResults(q);
  }, [searchParams]);

  const fetchResults = async (searchQuery) => {
    try {
      const res = await axios.get(`${API_URL}/search`, { params: { q: searchQuery } });
      setItems(res.data);
    } catch (err) {
      console.error(err);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setSearchParams(query ? { q: query } : {});
  };

  const triggerScan = async () => {
    alert("Scanning started... check server console.");
    await axios.post(`${API_URL}/scan`);
    alert("Scan finished! Refreshing results.");
    fetchResults(query);
  };

  // --- NAVIGATION LOGIC ---

  const openViewer = (index) => {
    setViewerIndex(index);
    setStoryPageIndex(0); // Reset story progress
    setIsFullscreen(true);
    // Add index to URL for sharing/persistence could be done here
  };

  const closeViewer = () => {
    setIsFullscreen(false);
    setViewerIndex(null);
  };

  const navigateViewer = (direction) => {
    const currentItem = items[viewerIndex];

    // If inside a story, try to change pages first
    if (currentItem.type === 'story') {
      const newPage = storyPageIndex + direction;
      if (newPage >= 0 && newPage < currentItem.pages.length) {
        setStoryPageIndex(newPage);
        return;
      }
    }

    // Otherwise, change Asset
    const newIndex = viewerIndex + direction;
    if (newIndex >= 0 && newIndex < items.length) {
      setViewerIndex(newIndex);
      setStoryPageIndex(0); // Reset for next item
    }
  };

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!isFullscreen) return;
      if (e.key === 'ArrowRight') navigateViewer(1);
      if (e.key === 'ArrowLeft') navigateViewer(-1);
      if (e.key === 'Escape') closeViewer();
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
        <form onSubmit={handleSearch} className="flex-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tags (e.g., SFW, CG)..."
            className="w-full p-2 rounded bg-gray-800 border border-gray-700 focus:outline-none focus:border-blue-500"
          />
        </form>
      </div>

      {/* GALLERY GRID */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
        {items.map((item, idx) => {
          const thumbnailPath = item.type === 'story' ? item.pages[0] : item.path;
          return (
            <div
              key={item.id}
              onClick={() => openViewer(idx)}
              className="relative group cursor-pointer border border-gray-700 rounded overflow-hidden bg-gray-800"
            >
              <div className="aspect-[2/3] overflow-hidden">
                <img
                  src={getMediaUrl(thumbnailPath)}
                  alt={item.name}
                  className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
              </div>
              <div className="p-2 text-sm">
                <p className="font-bold truncate text-blue-300">{item.artist}</p>
                <div className="flex justify-between items-center">
                  <p className="truncate opacity-80">{item.name}</p>
                  {item.type === 'story' && <Book size={14} className="text-yellow-500" />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* FULLSCREEN VIEWER */}
      {isFullscreen && currentItem && (
        <div className="fixed inset-0 bg-black bg-opacity-95 z-50 flex flex-col items-center justify-center">

          {/* Top Bar */}
          <div className="absolute top-0 left-0 right-0 p-4 flex justify-between bg-black/50 backdrop-blur-sm">
            <div>
              <h2 className="text-xl font-bold">{currentItem.artist} / {currentItem.name}</h2>
              {currentItem.type === 'story' && (
                <span className="text-yellow-400 text-sm">
                  Page {storyPageIndex + 1} of {currentItem.pages.length}
                </span>
              )}
            </div>
            <button onClick={closeViewer}><X size={32} /></button>
          </div>

          {/* Main Content */}
          <div className="flex-1 flex items-center justify-center w-full h-full p-4">
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
                    className="max-h-full max-w-full object-contain"
                  />
                );
              }
              return (
                <img
                  src={getMediaUrl(pathToShow)}
                  className="max-h-full max-w-full object-contain shadow-2xl"
                />
              );
            })()}
          </div>

          {/* Navigation Overlay Hints */}
          <button
            className="absolute left-4 top-1/2 -translate-y-1/2 p-4 bg-white/10 hover:bg-white/20 rounded-full"
            onClick={(e) => { e.stopPropagation(); navigateViewer(-1); }}
          >
            <ArrowLeft size={32} />
          </button>
          <button
            className="absolute right-4 top-1/2 -translate-y-1/2 p-4 bg-white/10 hover:bg-white/20 rounded-full"
            onClick={(e) => { e.stopPropagation(); navigateViewer(1); }}
          >
            <ArrowRight size={32} />
          </button>
        </div>
      )}
    </div>
  );
}
