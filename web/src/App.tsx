import { BrowserRouter, Route, Routes } from "react-router";
import { BenchmarkPage } from "@/pages/BenchmarkPage";
import { ChatPage } from "@/pages/ChatPage";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<ChatPage />} />
        <Route path="/benchmark" element={<BenchmarkPage />} />
        <Route path="*" element={<ChatPage />} />
      </Routes>
    </BrowserRouter>
  );
}
