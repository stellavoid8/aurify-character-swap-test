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

Second set (added 2026-10-23), same kind of stand-in: CC0 Unsplash photos on Commons, grouped by ArcFace (same person ≥ 0.42, different people ≤ 0.12) and checked by eye. None of them matches a template or `user-a`/`user-b`. Men: `user-c`, `user-d`, `user-e`. Women: `user-f`, `user-g`.

| File | Face height | Frontal | Source | Author | License |
| --- | --- | --- | --- | --- | --- |
| `user-c-1.jpg` | 16% | 0.93 | [Man in denim jacket posing (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Man_in_denim_jacket_posing_(Unsplash).jpg) | Brooke Cagle brookecagle | CC0 |
| `user-c-2.jpg` | 14% | 0.00 | [Man looking at ocean (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Man_looking_at_ocean_(Unsplash).jpg) | Brooke Cagle brookecagle | CC0 |
| `user-d-1.jpg` | 17% | 0.92 | [Man in t-shirt posing (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Man_in_t-shirt_posing_(Unsplash).jpg) | Mohammad Faruque primitivestudios | CC0 |
| `user-d-2.jpg` | 7% | 0.77 | [Young man at Palm Beach (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Young_man_at_Palm_Beach_(Unsplash).jpg) | Mohammad Faruque primitivestudios | CC0 |
| `user-e-1.jpg` | 28% | 0.74 | [Man vanguard glasses outdoors (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Man_vanguard_glasses_outdoors_(Unsplash).jpg) | Seth Doyle sethdoylee | CC0 |
| `user-e-2.jpg` | 43% | 0.50 | [Seth Doyle 2017-01-31 (Unsplash Vnm4aweBwPA).jpg](https://commons.wikimedia.org/wiki/File:Seth_Doyle_2017-01-31_(Unsplash_Vnm4aweBwPA).jpg) | Seth Doyle sethdoylee | CC0 |
| `user-f-1.jpg` | 41% | 0.96 | [Smiling woman (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Smiling_woman_(Unsplash).jpg) | Allef Vinicius seteales | CC0 |
| `user-f-2.jpg` | 16% | 0.65 | [Woman in a hat by red flowers (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Woman_in_a_hat_by_red_flowers_(Unsplash).jpg) | Allef Vinicius seteales | CC0 |
| `user-f-3.jpg` | 20% | 0.64 | [Allef Vinicius 2016-07-12 (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Allef_Vinicius_2016-07-12_(Unsplash).jpg) | Allef Vinicius seteales | CC0 |
| `user-f-4.jpg` | 12% | 0.97 | [Allef Vinicius 2016-07-08 (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Allef_Vinicius_2016-07-08_(Unsplash).jpg) | Allef Vinicius seteales | CC0 |
| `user-g-1.jpg` | 42% | 0.94 | [Seth Doyle 2017-01-31 (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Seth_Doyle_2017-01-31_(Unsplash).jpg) | Seth Doyle sethdoylee | CC0 |
| `user-g-2.jpg` | 31% | 0.70 | [Woman in jumper posing (Unsplash).jpg](https://commons.wikimedia.org/wiki/File:Woman_in_jumper_posing_(Unsplash).jpg) | Seth Doyle sethdoylee | CC0 |

`user-f` is the strongest new identity: four photos from different days and places, two of them very frontal. The men are weaker. About 1,400 CC0 portraits on Commons were searched, and no new man appeared in three clean shots; most series were one-offs or wore sunglasses throughout. So each man has one good frontal photo plus one hard one: `user-c-2` is a full profile, `user-d-2` a small full-length face, and `user-e-2` is at 0.50 with a knee near the face. Use the `-1` photo as the single reference, and add the `-2` photo to test whether a second, harder photo helps or hurts likeness. `user-e` wears clear glasses in both, and `user-f` wears a hat in all four. The two `user-g` photos come from one shoot and score only 0.42 against each other: the head tilt and hand on the face lower the match.

Known gaps: `user-a` and `user-b` each have two photos rather than three, and the child has one; `user-a-2` looks down with eyes hidden; both `user-b` photos come from one shoot (same outfit and light). There is no `user-a-3` or `user-child-2` yet. Still missing: a man with three or more clean photos (consenting teammates or synthetic faces are the way to get one) and anyone over about 40.

Requirements for real user photos:

- `user-a-*` (man), `user-b-*` (woman): people who agreed in writing, before any photo was taken or shared, to their face being used in this test. Teammates, or paid models whose release covers AI and biometric use.
- `user-child-1`: only with written consent from the child's parent or guardian. Otherwise use a synthetic face, or drop the `case3_a2c` pairs.
- Synthetic (AI-generated) faces are an acceptable substitute for any of them: no one's identity is involved and ArcFace scores them like real faces.

Each should be sharp, evenly lit and mostly frontal (frontalness above 0.7), without sunglasses. Photos of the same person should differ in setting and angle, and none should be one of the templates.

## Video templates

Clips for `scripts/bakeoff-video.ts`, used in `bakeoff/video-pairs.json` (shape: `video-pairs.example.json`). The files are not committed (`bakeoff/videos/` is gitignored); download the 1080p (or 720p where noted) MP4 from each Mixkit page into `bakeoff/videos/` under the name shown. `talk-greenscreen-man.mp4` was trimmed from 15.95 s to 15.0 s (`ffmpeg -i in.mp4 -t 15 -c:v libx264 -crf 18 -an`).

Each was vetted on five frames (10/30/50/70/90%): one face in every frame, the same identity throughout (lowest ArcFace cosine between frames ≥ 0.33), with face height and frontalness as the median of those frames. All are men or women who are clearly adults, checked by eye. Mixkit clips have no audio track, so this set cannot test whether the output keeps the clip's audio; that needs a clip with sound recorded by the team.

Licence: [Mixkit Stock Video Free License](https://mixkit.co/license/#videoFree): free for commercial and non-commercial use, no attribution, but the clips must not be redistributed as stock. Mixkit has no model releases covering face swap, so keep outputs internal.

| File | Tests | Length | Source | Face height | Frontal | Mixkit page |
| --- | --- | --- | --- | --- | --- | --- |
| `street-smile-man.mp4` | baseline (man) | 14.0 s | 720p 25 fps | 43% | 0.91 | [33435](https://mixkit.co/free-stock-video/young-man-on-the-street-smiling-portrait-33435/) |
| `smile-woman.mp4` | baseline (woman) | 10.1 s | 1080p 30 fps | 54% | 0.91 | [4859](https://mixkit.co/free-stock-video/portrait-of-a-happy-smiling-woman-4859/) |
| `talk-greenscreen-man.mp4` | talking, gestures, 60 fps | 15.0 s | 1080p 60 fps | 29% | 0.80 | [28287](https://mixkit.co/free-stock-video/man-talking-head-on-on-a-chroma-background-28287/) |
| `podcast-woman.mp4` | talking, head turns, foreground blur | 15.0 s | 1080p 24 fps | 34% | 0.58 | [52184](https://mixkit.co/free-stock-video/a-mature-beautiful-woman-talking-lively-to-the-microphone-in-52184/) |
| `laugh-closeup-man.mp4` | very large face, expression | 6.9 s | 1080p 25 fps | 68% | 0.68 | [4760](https://mixkit.co/free-stock-video/man-laughing-head-on-closeup-4760/) |
| `walk-park-woman.mp4` | walking, tracking camera | 10.6 s | 1080p 30 fps | 44% | 0.93 | [4825](https://mixkit.co/free-stock-video/girl-from-the-front-walking-through-a-park-4825/) |
| `radio-profile-man.mp4` | three-quarter profile, vertical 9:16 | 14.5 s | 1080×1920 24 fps | 31% | 0.35 | [2963](https://mixkit.co/free-stock-video/man-talking-in-front-of-a-radio-station-microphone-2963/) |
| `curly-hair-woman.mp4` | hair over face, head turns | 14.2 s | 1080p 24 fps | 32% | 0.33 | [51997](https://mixkit.co/free-stock-video/portrait-of-a-young-woman-with-abundant-curly-hair-modeling-51997/) |
| `dance-park-woman.mp4` | fast motion, arms near face | 14.4 s | 1080p 30 fps | 37% | 0.58 | [4886](https://mixkit.co/free-stock-video/african-american-girl-dancing-while-walking-in-a-park-4886/) |
| `singer-neon-man.mp4` | mic over mouth, coloured light | 11.9 s | 720p 25 fps | 52% | 0.82 | [13012](https://mixkit.co/free-stock-video/a-man-singing-to-a-professional-microphone-13012/) |
| `senior-woman.mp4` | age gap (senior in the clip), tight close-up | 12.5 s | 720p 25 fps | 95% | 0.62 | [32837](https://mixkit.co/free-stock-video/very-happy-and-surprised-senior-woman-portrait-32837/) |
| `head-down-man.mp4` | head bowed, looking down | 13.3 s | 720p 25 fps | 36% | 0.83 | [46448](https://mixkit.co/free-stock-video/man-cries-outside-with-heart-break-46448/) |
| `phone-walk-woman.mp4` | walking, hand and phone at face | 11.2 s | 1080p 24 fps | 24% | 0.80 | [232](https://mixkit.co/free-stock-video/woman-walks-through-the-city-speaking-on-the-phone-232/) |
| `over-limit-24s-woman.mp4` | upload rejection (24 s > `MAX_VIDEO_SECONDS`); not in the pairs file | 24.0 s | 1080p 25 fps | 43% | 0.87 | [4689](https://mixkit.co/free-stock-video/happy-smiling-girl-4689/) |

Excluded after review: Mixkit clips with IDs above 100000 return 403 to direct downloads, and clips with two or more faces, cuts between people, or swimwear.
