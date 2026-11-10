"""
desktop.py
Standalone Desktop Window Launcher for Multi-Speaker Transcript Review Interface.
Wraps the application in a native desktop window using pywebview (Edge WebView2 / WebKit).
If pywebview is unavailable, automatically falls back to the default web browser.
"""

import sys
import os
import socket
import threading
import time
import urllib.request
import webbrowser

# Ensure project root is in sys.path
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.join(PROJECT_ROOT, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app import ReviewRequestHandler, ThreadingHTTPServer


def find_free_port(start_port: int = 8000) -> int:
    """Finds an available local TCP port starting from start_port."""
    for port in range(start_port, start_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    return start_port


def wait_for_server(url: str, timeout: float = 6.0) -> bool:
    """Polls the local server until it responds with HTTP 200."""
    start_time = time.time()
    while time.time() - start_time < timeout:
        try:
            with urllib.request.urlopen(url, timeout=0.5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            time.sleep(0.1)
    return False


def main():
    port = find_free_port(8000)
    server_address = ("127.0.0.1", port)
    app_url = f"http://127.0.0.1:{port}"

    try:
        httpd = ThreadingHTTPServer(server_address, ReviewRequestHandler)
    except Exception as e:
        print(f"[ERROR] Could not bind server to port {port}: {e}")
        sys.exit(1)

    # Start backend server in a background daemon thread
    server_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    server_thread.start()

    print("=" * 65)
    print("   SnapWave - Multi-Speaker Transcript Review Studio")
    print(f"   Internal URL: {app_url}")
    print("=" * 65)

    ready = wait_for_server(f"{app_url}/")
    if not ready:
        print("[WARNING] Server took longer than expected to respond, launching window anyway...")

    has_webview = False
    try:
        import webview
        has_webview = True
    except ImportError:
        has_webview = False

    if has_webview and "--browser" not in sys.argv:
        print("[*] Launching native desktop window (Edge WebView2 / WebKit)...")
        try:
            window = webview.create_window(
                title="SnapWave - Multi-Speaker Transcript Review Studio",
                url=app_url,
                width=1420,
                height=880,
                min_size=(960, 640),
                background_color="#0b0f19",
                text_select=True
            )
            # webview.start blocks until the window is closed by the user
            webview.start(private_mode=False)
            print("\n[INFO] Desktop window closed. Shutting down server...")
        except Exception as e:
            print(f"[WARNING] Native window could not be opened: {e}")
            print("[*] Falling back to default web browser...")
            webbrowser.open(app_url)
            try:
                server_thread.join()
            except KeyboardInterrupt:
                pass
    else:
        print("[*] pywebview not installed or --browser specified. Opening in default browser...")
        webbrowser.open(app_url)
        print("Server is running! Press Ctrl+C in this console to exit.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nShutting down server...")

    try:
        httpd.shutdown()
        httpd.server_close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
