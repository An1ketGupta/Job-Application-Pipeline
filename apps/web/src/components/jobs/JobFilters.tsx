'use client';

import React, { useEffect, useState } from 'react';

export interface FilterValues {
  search: string;
  location: string;
  remote: string;
  platform: string;
  status: string;
}

interface JobFiltersProps {
  filters: FilterValues;
  onChange: (filters: FilterValues) => void;
  onReset: () => void;
}

export function JobFilters({ filters, onChange, onReset }: JobFiltersProps) {
  const [searchInput, setSearchInput] = useState(filters.search);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== filters.search) {
        onChange({ ...filters, search: searchInput });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, filters, onChange]);

  // Keep local input in sync if parent resets
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);

  const hasActiveFilters =
    filters.search ||
    filters.location ||
    filters.remote !== 'any' ||
    filters.platform !== 'all' ||
    filters.status !== 'ALL';

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {/* Search */}
        <div>
          <label
            htmlFor="search-input"
            className="block text-xs font-semibold text-slate-700"
          >
            Search Jobs
          </label>
          <div className="relative mt-1">
            <input
              id="search-input"
              type="text"
              placeholder="Title, company, or keywords..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            {searchInput && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchInput('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Location */}
        <div>
          <label
            htmlFor="location-input"
            className="block text-xs font-semibold text-slate-700"
          >
            Location
          </label>
          <input
            id="location-input"
            type="text"
            placeholder="e.g. San Francisco, New York..."
            value={filters.location}
            onChange={(e) => onChange({ ...filters, location: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        {/* Remote Status */}
        <div>
          <label
            htmlFor="remote-select"
            className="block text-xs font-semibold text-slate-700"
          >
            Workplace
          </label>
          <select
            id="remote-select"
            value={filters.remote}
            onChange={(e) => onChange({ ...filters, remote: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="any">All Workplaces</option>
            <option value="true">Remote Only</option>
            <option value="false">On-site / Hybrid Only</option>
          </select>
        </div>

        {/* Platform */}
        <div>
          <label
            htmlFor="platform-select"
            className="block text-xs font-semibold text-slate-700"
          >
            Application Platform
          </label>
          <select
            id="platform-select"
            value={filters.platform}
            onChange={(e) => onChange({ ...filters, platform: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="all">All Platforms</option>
            <option value="GREENHOUSE">Greenhouse</option>
            <option value="LEVER">Lever</option>
            <option value="WORKDAY">Workday</option>
            <option value="ASHBY">Ashby</option>
            <option value="SMARTRECRUITERS">SmartRecruiters</option>
            <option value="DIRECT_PORTAL">Direct Portal</option>
            <option value="EMAIL">Email</option>
            <option value="GOOGLE_FORM">Google Form</option>
          </select>
        </div>

        {/* Application Status */}
        <div>
          <label
            htmlFor="status-select"
            className="block text-xs font-semibold text-slate-700"
          >
            Application State
          </label>
          <select
            id="status-select"
            value={filters.status}
            onChange={(e) => onChange({ ...filters, status: e.target.value })}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            <option value="ALL">All Statuses</option>
            <option value="NOT_APPLIED">Not Applied</option>
            <option value="APPLIED">Applied / Any Status</option>
            <option value="IN_PROGRESS">In Progress</option>
            <option value="HUMAN_REQUIRED">Needs Review</option>
            <option value="SUBMITTED">Submitted</option>
          </select>
        </div>

        {/* Clear Filters */}
        <div className="flex items-end">
          {hasActiveFilters && (
            <button
              type="button"
              onClick={onReset}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors"
            >
              Reset Filters
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
