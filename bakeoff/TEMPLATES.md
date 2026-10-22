# Bake-off template photos

Openly licensed photos from Wikimedia Commons, used as templates in `bakeoff/pairs.example.json`.
The files themselves are not committed (`bakeoff/images/` is gitignored); download the 1920 px version from each page into `bakeoff/images/` under the name shown.
Each template shows exactly one face the detector finds, so the subject is never ambiguous. Check new ones with `npx tsx scripts/face-check.ts bakeoff/images/*.jpg`.
CC BY / CC BY-SA photos require credit to the author if any output is published.

One template per case, plus a held object, a backlit scene and a wide shot. Case 1 and case 3_a2c use an easy control (frontal, evenly lit, face 20–30% of image height), so a low likeness score there can be blamed on the model rather than the photo.
Face height and frontalness (1 = facing the camera) are as `face-check.ts` reports them.

| File | Used for | Face height | Frontal | Source | Author | License |
| --- | --- | --- | --- | --- | --- | --- |
| `frontal-man-studio.jpg` | control: case1, case3_a2c | 23% | 0.88 | [Always smile (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Always_smile_(Unsplash).jpg) | michael m_minimal | CC0 |
| `guitar-woman.jpg` | case1 (held object) | 20% | 0.31 | [Woman with acoustic guitar (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Woman_with_acoustic_guitar_(Unsplash).jpg) | Nick Karvounis nickkarvounis | CC0 |
| `shutter-man.jpg` | case2_m2f | 28% | 0.83 | [Sitting And Smiling (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Sitting_And_Smiling_(Unsplash).jpg) | Brooke Cagle brookecagle | CC0 |
| `cornfield-woman.jpg` | case2_f2m | 35% | 0.69 | [Smiling in a cornfield (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Smiling_in_a_cornfield_(Unsplash).jpg) | Allef Vinicius seteales | CC0 |
| `umbrella-girl.jpg` | case3_c2a | 21% | 0.85 | [Portrait of a little girl with an umbrella.jpg](https://commons.wikimedia.org/wiki/File:Portrait_of_a_little_girl_with_an_umbrella.jpg) | BogTar201213 | CC BY-SA 4.0 |
| `sunset-sea-backlit.jpg` | stress | 20% | 0.17 | [Sunset Portrait (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Sunset_Portrait_(Unsplash).jpg) | Tiago Aguiar tiagoaguiar | CC0 |
| `street-wide.jpg` | stress | 5% | 0.82 | [A Pause in New York (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:A_Pause_in_New_York_(Unsplash).jpg) | Alasdair Elmes alelmes | CC0 |

Two Unsplash files (`street-wide.jpg`, `sunset-sea-backlit.jpg`) carry "Copyright 2017. All rights reserved." in their EXIF despite the CC0 listing on Commons. Fine for internal testing; check the licence before publishing any output made from them.

## User photos

The `user-*.jpg` files are the likeness references every result is scored against, so they matter more than the templates.

Current stand-ins: CC0 Unsplash shoots on Commons where one model appears in several photos (matched by ArcFace cosine, then checked by eye). The models posed for public stock but did not agree to face swapping specifically, so keep outputs internal and replace them with consenting people before any results are shared.

| File | Face height | Frontal | Source | Author | License |
| --- | --- | --- | --- | --- | --- |
| `user-a-1.jpg` | 60% | 0.98 | [Christopher Campbell 2015-09-09 (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Christopher_Campbell_2015-09-09_(Unsplash).jpg) | Christopher Campbell chrisjoelcampbell | CC0 |
| `user-a-2.jpg` | 25% | 0.93 | [Tallebudgera Creek man (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Tallebudgera_Creek_man_(Unsplash).jpg) | Christopher Campbell chrisjoelcampbell | CC0 |
| `user-b-1.jpg` | 44% | 0.86 | [Brooke Cagle 2017-06-01 (Unsplash 6e9NdtnJYxU).jpg](https://commons.wikimedia.org/wiki/File:Brooke_Cagle_2017-06-01_(Unsplash_6e9NdtnJYxU).jpg) | Brooke Cagle brookecagle | CC0 |
| `user-b-2.jpg` | 17% | 0.14 | [Laughing in Journey t-shirt (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Laughing_in_Journey_t-shirt_(Unsplash).jpg) | Brooke Cagle brookecagle | CC0 |
| `user-child-1.jpg` | 39% | 0.92 | Supplied by the team; parent/guardian written consent confirmed 2026-10-22 (form kept outside the repo) | — | Consent only: internal test use |

Known gaps: each adult has two photos rather than three, and the child has one; `user-a-2` looks down with eyes hidden; both `user-b` photos come from one shoot (same outfit and light). There is no `user-a-3` or `user-child-2` yet.

Requirements for real user photos:

- `user-a-*` (man), `user-b-*` (woman): people who agreed in writing, before any photo was taken or shared, to their face being used in this test. Teammates, or paid models whose release covers AI and biometric use.
- `user-child-1`: only with written consent from the child's parent or guardian. Otherwise use a synthetic face, or drop the `case3_a2c` pairs.
- Synthetic (AI-generated) faces are an acceptable substitute for any of them: no one's identity is involved and ArcFace scores them like real faces.

Each should be sharp, evenly lit and mostly frontal (frontalness above 0.7), without sunglasses. Photos of the same person should differ in setting and angle, and none should be one of the templates.
