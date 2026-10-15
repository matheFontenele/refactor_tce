/* SQL Studio — Página principal com Monaco Editor */
import MonacoSQLEditor from "@/components/MonacoSQLEditor";
import { useSavedQueries } from "@/hooks/useSavedQueries";

export default function SQLStudioPage() {
  const { queries, addQuery } = useSavedQueries();

  const handleSaveQuery = (name: string) => {
    const editor = (document.querySelector('[ref="editorRef"]') as any)?.getValue();
    if (editor && editor.trim()) {
      addQuery(name, editor.trim());
      alert(`Query "${name}" salva!`);
    }
  };

  return (
    <div className="min-vh-100 bg-gray-900 text-white p-4">
      <h1 className="mb-6 font-bold text-32 text-gray-200">
        SQL Studio — Consulta Analítica Interativa
      </h1>

      <div className="mb-4 flex gap-2 flex-wrap">
        {/* Saved queries panel */}
        <div className="rounded-md bg-gray-800 p-3 max-w-300">
          <h3 className="font-small text-gray-400 mb-2">Queries Salvas</h3>
          {queries.length === 0 ? (
            <p className="text-gray-500 small">Nenhuma query salva ainda.</p>
          ) : (
            <ul className="text-sm text-gray-300 small space-y-1">
              {queries.map((q) => (
                <li key={q.name} className="cursor-pointer hover:text-primary-500 small">
                  {q.name}
                  <button
                    className="ml-2 text-primary-400 small"
                    onClick={() => {
                      // Load query into editor
                      const textarea = document.querySelector('textarea[ref="editorRef"]') as any;
                      if (textarea) {
                        textarea.value = q.sql;
                        textarea.dispatchEvent(new Event("input", { bubbles: true }));
                      }
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Quick actions */}
        <div className="flex gap-2">
          <button
            onClick={() => addQuery("nova-query", "")}
            className="btn-primary rounded py-2 px-3 text-sm flex items-center justify-center"
          >
            Nova
            <svg className="w-2 h-2 ml-1" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 5v14M5 12h14"/>
            </svg>
          </button>
          <button
            onClick={() => handleSaveQuery("minha-query")}
            className="btn-secondary rounded py-2 px-3 text-sm"
          >
            Salvar
          </button>
        </div>
      </div>

      <MonacoSQLEditor />
    </div>
  );
}