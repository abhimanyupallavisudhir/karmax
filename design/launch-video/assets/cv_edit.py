# The demo agent's CV edit: tavya goes first under Projects.
p = 'cv/cv.tex' if __import__('os').path.exists('cv/cv.tex') else 'cv.tex'
s = open(p).read()
item = r"  \item \textbf{tavya} (tavya.io) --- \emph{2026--present}. A to-do list for AI agents: every task runs in its own cloud computer, agents pay, sign up and deploy within budgets you set, and review is human or AI."
s = s.replace(r"\begin{itemize}", "\\begin{itemize}\n" + item, 1)
open(p, 'w').write(s)
