"use client";

import { useEffect, useState } from "react";

/** Hook for SSE connections to SQL execution streaming */
export function useSSE(url: string, onMessage: (msg: any) => void) {
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      setInitialized(true);
    };

    eventSource.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        onMessage(msg);
      } catch {
        // Ignore non-JSON messages
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [url, onMessage]);
}

/** Hook for managing saved queries in local storage */
export function useSavedQueries() {
  const [queries, setQueries] = useState<{ name: string; sql: string }[]>(() => {
    try {
      const stored = localStorage.getItem("saved_queries");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("saved_queries", JSON.stringify(queries));
    } catch {
      // Ignore storage errors
    }
  }, [queries]);

  const addQuery = (name: string, sql: string) => {
    const updated = queries.filter((q) => q.name !== name);
    setQueries([...queries, { name, sql }]);
  };

  const removeQuery = (name: string) => {
    setQueries(queries.filter((q) => q.name !== name));
  };

  const getQuery = (name: string) => {
    return queries.find((q) => q.name === name);
  };

  return { queries, addQuery, removeQuery, getQuery };
}