// The operator console shell.
//
// Eight surfaces, each named after a QUESTION rather than a table. The six it
// replaces — Health, Exceptions, Kill switches, Registry, Vendors, Vault —
// were each named after a noun in the database, and between them they answered
// none of "what needs me", "is it running" and "how is this customer doing".
//
// ⛔ There is no demo mode. Signed out, the console shows a sign-in screen and
// nothing else. The version this replaces rendered a full dashboard from
// `@adw/demo-data` fixtures whenever a request failed — including on a 403 —
// so an operator whose session had expired saw $63,384 MRR and 2,187 customers
// over a database holding one. Blank is a fine thing for a console to be.

import { useEffect, useState } from "react";
import { HashRouter, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, isOk, type OpsUser } from "./api.ts";
import { ViewBoundary, usePoll } from "./primitives.tsx";
import { Login } from "./Login.tsx";
import { Now } from "./views/Now.tsx";
import { Customers, CustomerView } from "./views/Customers.tsx";
import { Acquisition } from "./views/Acquisition.tsx";
import { Fleet } from "./views/Fleet.tsx";
import { Models } from "./views/Models.tsx";
import { Vendors } from "./views/Vendors.tsx";
import { Controls } from "./views/Controls.tsx";
import { Search } from "./views/Search.tsx";
import "./console.css";

function useTheme(): ["light" | "dark", () => void] {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("adw-ops-theme") as "light" | "dark" | null) ?? "light",
  );
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("adw-ops-theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

const NAV = [
  {
    label: "Operate",
    items: [
      { to: "/", label: "Now", el: <Now />, end: true },
      { to: "/customers", label: "Customers", el: <Customers /> },
      { to: "/acquisition", label: "Acquisition", el: <Acquisition /> },
    ],
  },
  {
    label: "Machinery",
    items: [
      { to: "/fleet", label: "Fleet", el: <Fleet /> },
      { to: "/models", label: "Models", el: <Models /> },
      { to: "/vendors", label: "Vendors & vault", el: <Vendors /> },
    ],
  },
  {
    label: "Act",
    items: [
      { to: "/controls", label: "Controls", el: <Controls /> },
      { to: "/search", label: "Search", el: <Search /> },
    ],
  },
];

export function App() {
  const [theme, toggleTheme] = useTheme();
  const [user, setUser] = useState<OpsUser | null | "unknown">("unknown");

  useEffect(() => {
    let cancelled = false;
    void api.me().then((me) => {
      if (!cancelled) setUser(me);
    });
    return () => { cancelled = true; };
  }, []);

  if (user === "unknown") {
    return <div className="login"><div className="login-inner"><div className="skeleton" /></div></div>;
  }
  if (user === null) return <Login onSignedIn={setUser} />;

  return (
    <HashRouter>
      <Shell user={user} theme={theme} toggleTheme={toggleTheme} onSignOut={() => setUser(null)} />
    </HashRouter>
  );
}

function Shell({
  user, theme, toggleTheme, onSignOut,
}: { user: OpsUser; theme: string; toggleTheme: () => void; onSignOut: () => void }) {
  // The rail's badge counts come from the same endpoint the home surface uses,
  // so the number beside "Now" can never disagree with the list under it.
  const [now] = usePoll(() => api.now(), 20_000);
  const waiting = isOk(now) && now.data.worklist.ok ? now.data.worklist.data.items.length : null;
  const unhealthyJobs =
    isOk(now) && now.data.jobs.ok ? now.data.jobs.data.filter((j) => j.state !== "ok").length : null;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="rail-mark">
          ADW <small>ops</small>
        </div>

        {NAV.map((group) => (
          <div className="rail-group" key={group.label}>
            <div className="rail-label">{group.label}</div>
            {group.items.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end ?? false}>
                <span>{item.label}</span>
                {item.to === "/" && waiting !== null && waiting > 0 ? (
                  <span className="rail-count" data-tone="bad">{waiting}</span>
                ) : item.to === "/fleet" && unhealthyJobs !== null && unhealthyJobs > 0 ? null : null}
              </NavLink>
            ))}
          </div>
        ))}

        <div className="rail-foot">
          <div className="rail-label" style={{ padding: 0 }}>{user.email}</div>
          <button className="btn" onClick={toggleTheme}>{theme === "dark" ? "Light" : "Dark"}</button>
          <SignOut onSignedOut={onSignOut} />
        </div>
      </aside>

      <main className="main">
        <Routes>
          {/* ⛔ Each view in its own boundary. One crashing must never blank
              the others — least of all Controls, which is where an operator
              goes to stop things. */}
          {NAV.flatMap((g) => g.items).map((item) => (
            <Route
              key={item.to}
              path={item.to}
              element={<ViewBoundary view={item.label}>{item.el}</ViewBoundary>}
            />
          ))}
          <Route
            path="/customers/:id"
            element={<ViewBoundary view="Customer"><CustomerView /></ViewBoundary>}
          />
        </Routes>
      </main>
    </div>
  );
}

function SignOut({ onSignedOut }: { onSignedOut: () => void }) {
  const navigate = useNavigate();
  return (
    <button
      className="btn"
      onClick={() => {
        void api.logout().then(() => {
          navigate("/");
          onSignedOut();
        });
      }}
    >
      Sign out
    </button>
  );
}
