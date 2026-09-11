---
name: Bug report
about: Something behaves differently from how it is documented
labels: bug
---

**What happened, and what you expected instead**

**Your hardware and browser**
The setup screen prints what it detected — GPU, threads, whether WebGPU is
available. Paste that if you can; most voice problems are hardware-shaped.

**Which model and which path**
On-device or cloud, and which model tier.

**The diagnostics timeline, if this was a live session**
Run `copy(__GREENROOM__.text())` in the browser console. The voice loop records
what it did because a live session cannot be stepped through in a debugger.
