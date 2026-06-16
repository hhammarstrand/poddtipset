/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ANTHROPIC_API_KEY: string;
  GENERATE_TOKEN: string;
}

export interface Source {
  title: string;
  url: string;
}

export interface ListenLinks {
  apple?: string;
  spotify?: string;
  web?: string;
  [key: string]: string | undefined;
}

// Rad som den lagras i D1 (listen_links/sources ar JSON-strangar).
export interface RecommendationRow {
  id: number;
  date: string;
  episode_title: string;
  show_name: string;
  show_slug: string;
  hosts: string;
  genre: string;
  language: string;
  year: number | null;
  duration_minutes: number | null;
  why_great: string;
  listen_links: string;
  sources: string;
  created_at: string;
}

// Rad som den exponeras via API:t (JSON-falt parsade).
export interface Recommendation {
  id: number;
  date: string;
  episode_title: string;
  show_name: string;
  show_slug: string;
  hosts: string;
  genre: string;
  language: string;
  year: number | null;
  duration_minutes: number | null;
  why_great: string;
  listen_links: ListenLinks;
  sources: Source[];
  created_at: string;
}

// Det modellen forvantas returnera (innan validering/normalisering).
export interface GeneratedTip {
  episode_title: string;
  show_name: string;
  hosts: string;
  genre: string;
  language: string;
  year: number | null;
  duration_minutes: number | null;
  why_great: string;
  listen_links: ListenLinks;
  sources: Source[];
}
