import { NavLink, Route, Routes } from "react-router-dom";
import { Home } from "./pages/Home";

export default function App() {
  return (
    <div>
      <nav>
        <NavLink to="/">Home</NavLink>
      </nav>
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
        </Routes>
      </main>
    </div>
  );
}
