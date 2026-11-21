import { Building2 } from "lucide-react";

export function App() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-slate-950 text-slate-100">
      <div className="sim-panel flex max-w-lg flex-col gap-3 rounded-2xl p-6">
        <div className="flex items-center gap-3">
          <Building2 className="h-6 w-6 text-amber-400" />
          <h1 className="text-xl font-bold tracking-tight">CodeCity Studio</h1>
        </div>
        <p className="text-sm text-slate-300">
          SimCity-inspired polyglot codebase time machine powered by DuckDB 2.0, DuckLake 1.1,
          Quack, and Tree-sitter.
        </p>
      </div>
    </div>
  );
}

export default App;
