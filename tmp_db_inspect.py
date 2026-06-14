import sqlite3
con = sqlite3.connect('C:/repos/http_proxy/data/artifacts.db')
cur = con.cursor()
print("TOTAL:", cur.execute("SELECT COUNT(*) FROM artifact").fetchone())
print("BY ROLE:")
for r in cur.execute("SELECT role, COUNT(*) FROM artifact GROUP BY role ORDER BY 2 DESC"):
    print(f"  {r[0] or '(none)':<30} {r[1]}")
print("BY MIME:")
for r in cur.execute("SELECT mime_type, COUNT(*) FROM artifact GROUP BY mime_type"):
    print(f"  {r[0]:<35} {r[1]}")
print("BY CATEGORY:")
for r in cur.execute("""SELECT c.name, COUNT(*) FROM artifact a 
  LEFT JOIN session sess ON a.session_id=sess.id 
  LEFT JOIN subject s ON sess.subject_id=s.id 
  LEFT JOIN category c ON s.category_id=c.id GROUP BY c.name"""):
    print(f"  {str(r[0]):<25} {r[1]}")
print("BY SUBJECT:")
for r in cur.execute("""SELECT s.name, COUNT(*) FROM artifact a 
  LEFT JOIN session sess ON a.session_id=sess.id 
  LEFT JOIN subject s ON sess.subject_id=s.id GROUP BY s.name"""):
    print(f"  {str(r[0]):<35} {r[1]}")
print("DISTINCT TAGS (sample 30):")
for r in cur.execute("SELECT DISTINCT tags FROM artifact WHERE tags IS NOT NULL LIMIT 30"):
    print(f"  {r[0]}")
con.close()
