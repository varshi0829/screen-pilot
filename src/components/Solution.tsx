"use client";

import { motion } from "framer-motion";
import { MousePointer2, MessageSquare, Target, ArrowRight } from "lucide-react";

const steps = [
  {
    number: "01",
    icon: MousePointer2,
    title: "Click the extension icon on any tab",
    description:
      "You're already on the page — any page. Click the ScreenPilot icon in your Chrome toolbar. A small widget slides in from the bottom-right corner of the tab you're on.",
    color: "#2563EB",
  },
  {
    number: "02",
    icon: MessageSquare,
    title: "Tell it what you want to do",
    description:
      "Type your goal in plain English. \"Submit the expense report.\" \"Find the filter and set it to last 30 days.\" No special syntax — just what you're trying to accomplish.",
    color: "#2563EB",
  },
  {
    number: "03",
    icon: Target,
    title: "Follow the highlights",
    description:
      "A pulsing ring appears on the exact element to click, with a small instruction bubble above it. Click it — ScreenPilot sees the result and moves to the next step automatically.",
    color: "#10B981",
  },
];

export default function Solution() {
  return (
    <section
      id="solution"
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
            How It Feels to Use It
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            Three steps, then you&apos;re done
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            ScreenPilot works on whatever page you&apos;re already on. No new tabs, no copy-pasting screenshots, no context switching.
          </p>
        </motion.div>

        <div className="relative grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Desktop connector */}
          <div className="hidden md:block absolute top-16 left-[calc(16.67%+24px)] right-[calc(16.67%+24px)] h-px bg-gradient-to-r from-[#2563EB]/25 via-[#2563EB]/15 to-[#10B981]/25 pointer-events-none" />

          {steps.map((step, i) => {
            const Icon = step.icon;
            return (
              <motion.div
                key={step.number}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.12 }}
                className="relative p-7 rounded-xl bg-white border border-black/[0.07] hover:border-black/[0.12] hover:shadow-sm transition-all duration-300"
              >
                <div className="flex items-center justify-between mb-6">
                  <span className="text-xs font-mono text-[#64748B] bg-[#F8FAFC] px-2.5 py-1 rounded-md border border-black/[0.06]">
                    {step.number}
                  </span>
                  {i < steps.length - 1 && (
                    <ArrowRight className="w-4 h-4 text-[#2563EB]/30 md:hidden" />
                  )}
                </div>

                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                  style={{ backgroundColor: `${step.color}12` }}
                >
                  <Icon className="w-6 h-6" style={{ color: step.color }} />
                </div>

                <h3 className="font-semibold text-[#0F172A] text-base mb-3">
                  {step.title}
                </h3>
                <p className="text-[#64748B] text-sm leading-relaxed">
                  {step.description}
                </p>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
