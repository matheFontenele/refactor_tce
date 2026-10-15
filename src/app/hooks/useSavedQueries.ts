/* Hook para gerenciar queries salvas */
"use client";

import { useEffect, useState } from "react";

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