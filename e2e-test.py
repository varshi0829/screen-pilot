#!/usr/bin/env python3
"""End-to-end test for ScreenPilot"""
import base64
import json
import urllib.request
import sys

# Read key from environment
import os
API_KEY = os.environ.get('GEMINI_API_KEY', '')
if not API_KEY:
    print("ERROR: GEMINI_API_KEY not set")
    sys.exit(1)

print(f"Using key: {API_KEY[:8]}...{API_KEY[-4:]}")

# Create a minimal 1x1 PNG for testing
png_data = base64.b64decode(b"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
img_b64 = base64.b64encode(png_data).decode('ascii')

# Test 1: Local backend
print("\n=== TEST 1: Local backend ===")
payload = {
    "screenshot": {"image": img_b64, "mimeType": "image/png"},
    "goal": "test goal"
}

req = urllib.request.Request(
    "http://localhost:3000/api/analyze",
    data=json.dumps(payload).encode('utf-8'),
    headers={"Content-Type": "application/json"},
    method="POST"
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode('utf-8')
        print(f"Status: {resp.status}")
        print(f"Response: {body[:500]}")
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8')
    print(f"Status: {e.code}")
    print(f"Response: {body[:500]}")
except Exception as e:
    print(f"Error: {e}")

# Test 2: Vercel backend
print("\n=== TEST 2: Vercel backend ===")
vercel_url = "https://screen-pilot-j1az.vercel.app/api/analyze"
req = urllib.request.Request(
    vercel_url,
    data=json.dumps(payload).encode('utf-8'),
    headers={"Content-Type": "application/json"},
    method="POST"
)

try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode('utf-8')
        print(f"Status: {resp.status}")
        print(f"Response: {body[:500]}")
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8')
    print(f"Status: {e.code}")
    print(f"Response: {body[:500]}")
except Exception as e:
    print(f"Error: {e}")