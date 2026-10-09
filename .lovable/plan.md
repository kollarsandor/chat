# Böngészőtől független chatmunka

## Eredmény
- Az elküldött feladat háttérmunkaként indul, nem az oldal nyitva tartásához kötve.
- Újratöltés vagy böngészőbezárás után a munka folytatódik.
- Visszanyitáskor a beszélgetés visszakapcsolódik, és megjeleníti az addigi gondolkodást, eszközlépéseket és választ.
- A leállítás és a futás közbeni új irány továbbra is működik.

## Megvalósítás
- Tartósan eltároljuk a munkát, az eseményeit, a válasz aktuális szövegét és az utolsó feldolgozott esemény sorszámát.
- Az Inngest csak a szerveroldali futtatást tartja életben; a chat felülete továbbra is a jelenlegi oldal marad.
- A küldés azonnal visszaad egy munkaazonosítót, majd az oldal külön eseményfolyamon követi a futást.
- A meglévő visszacsatlakozó felületet bekötjük az új háttérvégpontokra, és mentjük az eseménykurzort a duplikációk elkerülésére.
- Az eddigi közvetlen `/api/chat` működést kompatibilis tartalékként meghagyjuk, de az oldal az új háttérmunkát használja.

## Technikai részletek
- Új szerveroldali táblák: chat beszélgetések, munkák és sorszámozott események; kizárólag a szerver kezeli őket.
- Új végpontok: munka indítása, események követése, leállítás, új irány, beszélgetések visszaállítása és Inngest futtató.
- Egy munka egyszer futhat, a befejezett események ismételt futásnál nem duplázódnak.
- A jelenlegi agent motor eseményküldését leválasztjuk a nyitott böngészőkapcsolatról, így ugyanaz a motor adatbázisba is írhat.
