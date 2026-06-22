"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Navigation2, Menu, X, Github } from "lucide-react";

const navLinks = [
  { label: "Features", href: "#features" },
  { label: "How It Works", href: "#how-it-works" },
  { label: "Demo", href: "#demo" },
  { label: "Architecture", href: "#architecture" },
  {
    label: "GitHub",
    href: "https://github.com/varshi0829/screen-pilot",
    external: true,
  },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/95 backdrop-blur-md border-b border-black/[0.06] shadow-sm"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-[1280px] mx-auto px-6 h-16 flex items-center justify-between">
        {/* Logo */}
        <a href="#" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#2563EB] flex items-center justify-center shadow-md shadow-blue-200">
            <Navigation2 className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-[#0F172A] text-[15px] tracking-tight">
            ScreenPilot
          </span>
        </a>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-0.5">
          {navLinks.map((link) => (
            <a
              key={link.label}
              href={link.href}
              target={link.external ? "_blank" : undefined}
              rel={link.external ? "noopener noreferrer" : undefined}
              className="px-3.5 py-2 text-sm text-[#64748B] hover:text-[#0F172A] transition-colors rounded-md hover:bg-black/[0.04]"
            >
              {link.label}
            </a>
          ))}
        </nav>

        {/* Desktop CTA */}
        <div className="hidden md:flex items-center gap-2">
          <span className="text-xs text-[#10B981] font-medium">No API key needed</span>
          <a
            href="/screenpilot-extension.zip"
            download="screenpilot-extension.zip"
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#2563EB] hover:bg-[#1D4ED8] text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Github className="w-4 h-4" />
            Install Extension
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden p-2 text-[#64748B] hover:text-[#0F172A] transition-colors"
          aria-label="Toggle menu"
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="md:hidden bg-white border-b border-black/[0.06] px-6 py-4 flex flex-col gap-1"
          >
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noopener noreferrer" : undefined}
                onClick={() => setMenuOpen(false)}
                className="px-3 py-2.5 text-sm text-[#64748B] hover:text-[#0F172A] transition-colors rounded-md"
              >
                {link.label}
              </a>
            ))}
            <a
              href="/screenpilot-extension.zip"
              download="screenpilot-extension.zip"
              className="mt-2 flex items-center justify-center gap-2 px-4 py-2.5 bg-[#2563EB] text-white text-sm font-medium rounded-lg"
            >
              <Github className="w-4 h-4" />
              Install Extension
            </a>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
