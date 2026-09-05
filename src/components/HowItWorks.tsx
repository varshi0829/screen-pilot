"use client";

import { motion } from "framer-motion";
import {
  Globe,
  MousePointer2,
  ScanSearch,
  Zap,
  Brain,
  Crosshair,
  RefreshCw,
} from "lucide-react";

const pipeline = [
  {
    icon: Globe,
    title: "You're on a webpage",
    description:
      "Open any site — Gmail, GitHub, a company portal. ScreenPilot doesn't care which one.",
    color: "#64748B",
  },
  {
    icon: MousePointer2,
    title: "Click the extension icon",
    description:
      "The ScreenPilot widget slides into the bottom-right corner of the current tab. You type your goal.",
    color: "#2563EB",
  },
  {
    icon: ScanSearch,
    title: "Page structure read locally",
    description:
      "ScreenPilot extracts a normalized snapshot of every visible button, link, and field on the page directly in your browser.",
    color: "#2563EB",
  },
  {
    icon: Zap,
    title: "Fast deterministic and DOM/semantic grounding",
    description:
      "A deterministic matcher, then a DOM/semantic grounding pass, try to resolve your goal against that snapshot for straightforward, unambiguous targets.",
    color: "#2563EB",
  },
  {
    icon: Brain,
    title: "Multimodal LLM handles ambiguous or complex cases",
    description:
      "When the target isn't clear-cut, a screenshot plus your goal go to a multimodal LLM (via the configured cloud or OpenRouter planner, or an optional local Qwen model), which returns the single next action as structured JSON.",
    color: "#2563EB",
  },
  {
    icon: Crosshair,
    title: "Highlight appears on the real element",
    description:
      "The target is located in the live DOM and highlighted with a pulsing ring and instruction bubble. You click it.",
    color: "#10B981",
  },
  {
    icon: RefreshCw,
    title: "ScreenPilot re-checks and continues",
    description:
      "The moment you act, it re-reads the page to confirm the goal is met — or plans the next single step from the new state. The loop is self-correcting by design.",
    color: "#10B981",
  },
];

export default function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="relative py-32 bg-[#F8FAFC] border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-20"
        >
          <p className="text-[11px] text-[#2563EB] uppercase tracking-[0.12em] font-semibold mb-4">
            Under the Hood
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            What happens when you click Go
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            Seven things happen between you typing a goal and a highlight appearing
            on your screen — page observation and grounding happen locally, and a
            multimodal model steps in for the cases that need it.
          </p>
        </motion.div>

        <div className="relative max-w-3xl mx-auto">
          {/* Vertical connecting line */}
          <div className="absolute left-[27px] top-6 bottom-6 w-px bg-gradient-to-b from-[#E2E8F0] via-[#2563EB]/20 to-[#10B981]/30 pointer-events-none" />

          <div className="flex flex-col gap-0">
            {pipeline.map((node, i) => {
              const Icon = node.icon;
              const isLast = i === pipeline.length - 1;
              return (
                <motion.div
                  key={node.title}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, delay: i * 0.07 }}
                  className="relative flex items-start gap-6 group"
                >
                  <div className="relative z-10 flex-shrink-0">
                    <div
                      className="w-14 h-14 rounded-xl flex items-center justify-center border transition-all duration-300 group-hover:shadow-sm"
                      style={{
                        backgroundColor: `${node.color}0D`,
                        borderColor: `${node.color}20`,
                      }}
                    >
                      <Icon className="w-5 h-5" style={{ color: node.color }} />
                    </div>
                  </div>

                  <div className={`flex-1 pt-3 ${isLast ? "pb-0" : "pb-9"}`}>
                    <div className="flex items-center gap-3 mb-1.5">
                      <h3 className="font-semibold text-[#0F172A] text-[15px]">
                        {node.title}
                      </h3>
                      <span
                        className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                        style={{
                          color: node.color,
                          backgroundColor: `${node.color}0D`,
                        }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                    </div>
                    <p className="text-[#64748B] text-sm leading-relaxed">
                      {node.description}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
