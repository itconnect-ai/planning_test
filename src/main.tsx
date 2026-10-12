import React from "react";
import { createRoot } from "react-dom/client";
import App from "./ui/App";
import "./style.css";
class ScreenBoundary extends React.Component<
  React.PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main>
          <h1>화면을 표시하지 못했습니다</h1>
          <p role="alert">
            저장된 기록을 초기화하지 않았습니다. 다시 열어 확인하세요.
          </p>
          <button onClick={() => location.reload()}>다시 열기</button>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ScreenBoundary>
      <App />
    </ScreenBoundary>
  </React.StrictMode>,
);
