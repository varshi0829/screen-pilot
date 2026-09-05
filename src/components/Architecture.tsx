"use client";

import { motion } from "framer-motion";
import {
  Chrome,
  ScanSearch,
  Layers3,
  GitBranch,
  Crosshair,
  ShieldCheck,
  ArrowRight,
  ArrowDown,
} from "lucide-react";

const topRow = [
  {
    icon: Chrome,
    title: "Chrome Extension",
    description: "Injects widget, routes messages, orchestrates the plan loop",
    color: "#2563EB",
  },
  {
    icon: ScanSearch,
    title: "Page State Extraction",
    description: "Live DOM → normalized, website-agnostic JSON every cycle",
    color: "#2563EB",
  },
  {
    icon: Layers3,
    title: "L1/L2/L3 Decision Router",
    description: "Deterministic grounding → DOM/semantic grounding → multimodal LLM",
    color: "#10B981",
  },
];

const bottomRow = [
  {
    icon: Crosshair,
    title: "Guidance Overlay",
    description: "Spotlight + ring + arrow + instruction bubble on the element",
    color: "#10B981",
  },
  {
    icon: GitBranch,
    title: "Executor + Session State",
    description: "Resolves the target, detects the real click, persists progress",
    color: "#2563EB",
  },
  {
    icon: ShieldCheck,
    title: "Goal Verifier",
    description: "Confirms the goal against the live page before ever replanning",
    color: "#2563EB",
  },
];

export default function Architecture() {
  return (
    <section
      id="architecture"
      className="relative py-32 bg-white border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-20"
        >
          <p className="text-[11px] text-[#10B981] uppercase tracking-[0.12em] font-semibold mb-4">
            System Design
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            Technical architecture
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            ScreenPilot observes the live page locally, then routes each step
            through deterministic grounding, DOM/semantic grounding, or
            multimodal reasoning. The browser executes the action and verifies
            the resulting state before continuing or replanning.
          </p>
        </motion.div>

        <div className="max-w-4xl mx-auto">
          {/* Top row */}
          <div className="grid grid-cols-3 gap-4 mb-4">
            {topRow.map((node, i) => {
              const Icon = node.icon;
              return (
                <motion.div
                  key={node.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.1 }}
                  className="relative p-5 rounded-xl bg-white border border-black/[0.07] hover:border-black/[0.12] hover:shadow-sm transition-all"
                >
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
                    style={{ backgroundColor: `${node.color}12` }}
                  >
                    <Icon className="w-5 h-5" style={{ color: node.color }} />
                  </div>
                  <h3 className="font-semibold text-[#0F172A] text-sm mb-1.5">
                    {node.title}
                  </h3>
                  <p className="text-[#64748B] text-xs leading-relaxed font-mono">
                    {node.description}
                  </p>

                  {i < topRow.length - 1 && (
                    <div className="hidden md:flex absolute -right-5 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-10">
                      <ArrowRight className="w-4 h-4 text-[#2563EB]/40" />
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>

          {/* Down arrow */}
          <div className="hidden md:grid grid-cols-3 gap-4 h-10">
            <div className="col-start-3 flex items-center justify-center">
              <ArrowDown className="w-4 h-4 text-[#10B981]/50" />
            </div>
          </div>

          {/* Bottom row (right to left) */}
          <div className="grid grid-cols-3 gap-4">
            {bottomRow.map((node, i) => {
              const Icon = node.icon;
              return (
                <motion.div
                  key={node.title}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: 0.3 + i * 0.1 }}
                  className="relative p-5 rounded-xl bg-white border border-black/[0.07] hover:border-black/[0.12] hover:shadow-sm transition-all"
                >
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center mb-3"
                    style={{ backgroundColor: `${node.color}12` }}
                  >
                    <Icon className="w-5 h-5" style={{ color: node.color }} />
                  </div>
                  <h3 className="font-semibold text-[#0F172A] text-sm mb-1.5">
                    {node.title}
                  </h3>
                  <p className="text-[#64748B] text-xs leading-relaxed font-mono">
                    {node.description}
                  </p>

                  {i < bottomRow.length - 1 && (
                    <div className="hidden md:flex absolute -right-5 top-1/2 -translate-y-1/2 z-10 items-center justify-center w-10">
                      <ArrowRight className="w-4 h-4 text-[#2563EB]/40 rotate-180" />
                    </div>
                  )}
                </motion.div>
              );
            })}
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.7 }}
            className="hidden md:flex mt-8 justify-center"
          >
            <div className="flex items-center gap-3 px-4 py-2 rounded-full border border-black/[0.07] bg-[#F8FAFC] text-xs text-[#64748B]">
              Extension → Page Observation → L1/L2/L3 Decision → Executor → Action → Observe → Verify → Replan
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
