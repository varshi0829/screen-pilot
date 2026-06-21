"use client";

import { motion } from "framer-motion";
import { Github, Star, GitFork, ExternalLink } from "lucide-react";

export default function GitHub() {
  return (
    <section className="relative py-32 bg-[#F8FAFC] border-t border-black/[0.05]">
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="max-w-2xl mx-auto rounded-2xl bg-white border border-black/[0.07] p-10 text-center shadow-sm"
        >
          <div className="w-14 h-14 rounded-2xl bg-[#0F172A] flex items-center justify-center mx-auto mb-6">
            <Github className="w-7 h-7 text-white" />
          </div>

          <h2 className="text-3xl font-bold text-[#0F172A] tracking-tight mb-3">
            It&apos;s open source
          </h2>
          <p className="text-[#64748B] text-base leading-relaxed mb-2">
            The extension, the vision service, the DOM matcher, the highlighting engine — all of it is in the repo. Read it, fork it, build on it.
          </p>
          <p className="text-sm text-[#94A3B8] font-mono mb-8">
            github.com/varshi0829/screen-pilot
          </p>

          <div className="flex items-center justify-center gap-6 mb-8">
            <div className="flex items-center gap-2 text-sm text-[#64748B]">
              <Star className="w-4 h-4 text-yellow-500" />
              <span>Star the repo</span>
            </div>
            <div className="w-px h-4 bg-black/[0.08]" />
            <div className="flex items-center gap-2 text-sm text-[#64748B]">
              <GitFork className="w-4 h-4 text-[#2563EB]" />
              <span>Fork and contribute</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://github.com/varshi0829/screen-pilot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-2.5 bg-[#0F172A] hover:bg-[#1E293B] text-white text-sm font-semibold rounded-lg transition-colors"
            >
              <Github className="w-4 h-4" />
              View Source
            </a>
            <a
              href="https://github.com/varshi0829/screen-pilot"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-2.5 border border-black/[0.1] text-[#0F172A] text-sm font-semibold rounded-lg hover:bg-black/[0.03] transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              Install Extension
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
