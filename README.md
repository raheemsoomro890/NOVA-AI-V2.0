# NOVA AI V2.0

> An intelligent, voice-enabled AI assistant platform powered by Node.js, Express, and Google Gemini.

[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)]()
[![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)]()
[![Deploy](https://img.shields.io/badge/deploy-Vercel-black)]()

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Environment Setup](#environment-setup)
- [Running Locally](#running-locally)
- [API Reference](#api-reference)
- [GitHub Usage](#github-usage)
- [Deployment on Vercel](#deployment-on-vercel)
- [Security Notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [License](#license)

---

## Overview

NOVA AI V2.0 is a full-stack voice assistant application. Users speak into the
browser, their speech is transcribed client-side, sent to a secure Express
backend, processed by Google's Gemini model, and the response is read back
aloud — all through a clean, production-ready architecture.

The Gemini API key never leaves the server. All AI calls are proxied through
a single, rate-limited `POST /api/chat` endpoint.

## Features

- 🎙️ **Voice Recognition** — real-time speech-to-text using the Web Speech API
- 🔊 **Speech Synthesis** — natural spoken responses via `SpeechSynthesisUtterance`
- 📊 **Live Audio Visualizer** — canvas-based waveform driven by the Web Audio API
- 🔄 **Finite State Machine** — predictable UI states (idle, listening, processing, speaking, error)
- 🔐 **Secure Gemini Integration** — API key stays server-side, never exposed to the client
- 🚦 **Rate Limiting** — per-route and global limits via `express-rate-limit`
- 🌐 **CORS Configured** — restrict or open cross-origin access via environment variable
- 🧱 **Clean Architecture** — layered backend, static frontend, easy to extend
- ⚡ **Vercel-Ready** — deploy the Express app and static frontend with one config
- 🛡️ **Centralized Error Handling** — consistent JSON error responses across the API

## Tech Stack

| Layer      | Technology                          |
|------------|--------------------------------------|
| Backend    | Node.js, Express                     |
| AI         | Google Gemini (`@google/generative-ai`) |
| Frontend   | HTML5, CSS3, Vanilla JavaScript      |
| Voice      | Web Speech API, Web Audio API        |
| Security   | CORS, express-rate-limit, dotenv     |
| Hosting    | Vercel                               |

## Project Structure
