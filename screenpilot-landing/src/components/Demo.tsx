"use client";

import { motion } from "framer-motion";
import { Mail, GitBranch, BarChart2, GraduationCap, Building2 } from "lucide-react";

const scenarios = [
  {
    icon: Mail,
    title: "Compose and schedule an email",
    description:
      "\"Schedule an email to the team about Q3 review for tomorrow at 2pm\" — ScreenPilot walks through Compose, To, Subject, body, and the schedule button.",
    app: "Gmail",
    steps: 6,
  },
  {
    icon: GitBranch,
    title: "Create a GitHub issue",
    description:
      "\"Create an issue about the login bug\" — clicks Issues, New issue, fills the title and description, submits. Works on any repository.",
    app: "GitHub",
    steps: 5,
  },
  {
    icon: BarChart2,
    title: "Pull a specific metric from a dashboard",
    description:
      "\"Show me MAU for the last 30 days\" — navigates the sidebar, applies the right filter, and lands on the correct chart view.",
    app: "Analytics",
    steps: 4,
  },
  {
    icon: GraduationCap,
    title: "Register for a course on a university portal",
    description:
      "\"Register for CS401 next semester\" — handles search, section selection, prerequisites check, and confirmation — even on portals nobody likes.",
    app: "University Portal",
    steps: 7,
  },
  {
    icon: Building2,
    title: "Submit an expense report",
    description:
      "\"Submit expense report for the Mumbai trip\" — navigates the finance tool, fills fields, uploads receipt placeholder, submits for approval.",
    app: "Enterprise",
    steps: 8,
  },
];

export default function Demo() {
  return (
    <section
      id="demo"
      className="relative py-32 bg-white border-t border-black/[0.05]"
    >
      <div className="max-w-[1280px] mx-auto px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center max-w-2xl mx-auto mb-14"
        >
          <p className="text-[11px] text-[#10B981] uppercase tracking-[0.12em] font-semibold mb-4">
            See It Live
          </p>
          <h2 className="text-4xl md:text-5xl font-bold text-[#0F172A] tracking-tight mb-4">
            Watch ScreenPilot in action
          </h2>
          <p className="text-[#64748B] text-lg leading-relaxed">
            A real recording of ScreenPilot guiding through a task — no cuts, no mock data.
          </p>
        </motion.div>

        {/* Video */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="mb-14 rounded-2xl overflow-hidden border border-black/[0.08] shadow-sm max-w-4xl mx-auto bg-[#0F172A]"
        >
          <video
            src="/demo.mp4"
            controls
            playsInline
            className="w-full block"
            style={{ maxHeight: "520px" }}
          >
            Your browser does not support the video tag.
          </video>
        </motion.div>

        {/* Scenario cards */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="mb-8"
        >
          <p className="text-[11px] text-[#64748B] uppercase tracking-[0.12em] font-semibold mb-6">
            What you can try
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {scenarios.map((scenario, i) => {
            const Icon = scenario.icon;
            return (
              <motion.div
                key={scenario.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.4, delay: i * 0.07 }}
                className="group p-6 rounded-xl bg-white border border-black/[0.07] hover:border-[#2563EB]/25 hover:shadow-sm transition-all duration-300"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="w-9 h-9 rounded-lg bg-[#EBF3FE] flex items-center justify-center group-hover:bg-[#2563EB]/15 transition-colors">
                    <Icon className="w-4 h-4 text-[#2563EB]" />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-[#64748B] font-medium bg-[#F8FAFC] px-2 py-0.5 rounded-full border border-black/[0.06]">
                      {scenario.app}
                    </span>
                    <span className="text-[10px] text-[#10B981] font-medium bg-[#10B981]/[0.08] px-2 py-0.5 rounded-full">
                      {scenario.steps} steps
                    </span>
                  </div>
                </div>
                <h3 className="font-semibold text-[#0F172A] text-sm mb-2 leading-snug">
                  {scenario.title}
                </h3>
                <p className="text-[#64748B] text-xs leading-relaxed">
                  {scenario.description}
                </p>
              </motion.div>
            );
          })}

          {/* Install CTA card */}
          <motion.a
            href="/screenpilot-extension.zip"
            download="screenpilot-extension.zip"
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.35 }}
            className="group p-6 rounded-xl bg-[#2563EB] border border-[#2563EB] hover:bg-[#1D4ED8] transition-all duration-300 flex flex-col justify-between cursor-pointer"
          >
            <div>
              <p className="text-white/70 text-xs font-medium uppercase tracking-wide mb-3">
                Try it yourself
              </p>
              <h3 className="font-semibold text-white text-base mb-2">
                Install the extension and run any of these — on the live site
              </h3>
              <p className="text-white/70 text-xs leading-relaxed">
                Downloads the extension zip. Load it in Chrome via
                chrome://extensions → Load unpacked.
              </p>
            </div>
            <div className="mt-6 flex items-center gap-2 text-white text-sm font-medium">
              Download extension
              <span className="group-hover:translate-x-1 transition-transform">→</span>
            </div>
          </motion.a>
        </div>
      </div>
    </section>
  );
}
