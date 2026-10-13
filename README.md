# Fastlane

Cars learn to drive a highway from nothing. No training data and no pretrained brains: every visit starts with a population of random, minimal networks, and NEAT grows them, adding neurons and connections as the road gets harder. The goal is to get past traffic on a road that keeps changing. It curves, narrows to two lanes, closes lanes for construction, changes weather and moves through different scenery. The levels never run out.

Written in TypeScript with the Canvas API. It started as a port of Radu Mariescu-Istodor's freeCodeCamp [Self-driving car](https://github.com/gniziemazity/Self-driving-car) course (MIT). It was rebuilt with typed modules and tests, then taken in its own direction: growing NEAT brains instead of a fixed network, unlimited procedurally generated levels, weather and themed roads.

Sister project: [Crosstown](https://github.com/evannwilsonn/crosstown), where the same kind of brains learn to drive a town and reach destinations against the clock.

## Run it

```bash
npm install
npm run dev               # local dev server
npm test                  # unit tests (Vitest)
npm run build             # dist/
SINGLE=1 npm run build    # one self-contained HTML file in dist-single/
```

Use the arrow keys or W A S D to drive in "Drive it yourself" mode.

## How the learning works

| Step | In this project |
| --- | --- |
| Problem | Drive with no labelled data, and keep improving as the challenge grows. |
| Inputs | Seven ray sensors across 180 degrees (0 when a ray sees nothing, rising to 1 as an obstacle gets close), the car's speed, the road ahead and the road condition. |
| Starting point | Generation 1 is random minimal networks: inputs wired straight to 4 controls (forward, left, right, reverse), no hidden neurons. |
| Model | A NEAT genome (`src/neat.ts`, after Stanley & Miikkulainen 2002): any acyclic network of step neurons, with as many hidden neurons as evolution has added. |
| Breeding | Brains are grouped into species by structure and compete mostly within their species, so a new neuron gets time to prove itself. Parents cross over gene by gene using innovation numbers. Mutations nudge weights and sometimes add a connection or split one with a new neuron. The best brain rides unchanged into the next generation, so progress never goes backwards. |
| Self-improvement | Unlimited levels. The leader's brain is drawn live as it grows, and a learning curve charts every generation by level, with a dot wherever the best brain gained a neuron. |
| Memory | Learning lasts for the browser tab session. Refreshing, or leaving and coming back in the same tab, keeps the brains and the level. Closing the tab or window starts over from random brains. |

## The highway

**Fitness** is distance gained on the traffic, not raw distance. Traffic moves forward too, so raw distance rewards tailgating, and a tailgater never learns to overtake.

**New traffic every generation.** Every generation gets newly generated traffic, level 1 included, so a brain can't memorize a layout. Each brain drives **two layouts per generation** and is scored on both. To clear a level, the goal has to be reached on **3 different layouts**. One lucky run isn't enough.

With a single layout per generation, a brain that happened to get easy traffic won, then failed the next generation's traffic, and the population swung back and forth instead of improving. That showed most on the first curvy road (level 7), where some populations stalled for 100+ generations.

**Inputs:** seven rays across 180 degrees, the car's speed, the road ahead, and the road condition.

- **Road ahead** is which way the road bends about 15 m on, compared with where the car points: what a driver sees through the windshield on a curve. Most crashes on curves were cars running off the edge, because the rays alone only show the road's edge once it's close.
- **Road condition** reads 0 dry, 0.5 wet and 1 icy.

Both are sensors, not knowledge: brains still start random and have to learn what they mean.

**Levels never run out**, and the road changes every three levels:

| Road | Levels | What changes |
| --- | --- | --- |
| 1 | 1-3 | Three straight lanes. Level 1 is the course's seven cars, in a random arrangement. |
| 2 | 4-6 | Two lanes, through the desert. Level 6: a sandstorm |
| 3 | 7-9 | Curves, along the coast. Level 9: rain |
| 4 | 10-12 | Construction zones that close a lane, downtown at night. Level 12: fog at night |
| 5 | 13-15 | Curves, lane closures and two or three lanes, over a snowy pass. Level 15: black ice and falling snow |
| 6+ | 16+ | Random mixes of the above, getting tighter, with each road's weather on its third level |

- **Traffic difficulty.** Within each road, traffic gets denser and faster. Each new road starts a little easier, so the brains get a foothold on the new shape.
- **Traffic behavior.** Later levels give lanes different speeds and add cars that change lanes.
- **Generated so it stays passable.** Traffic follows its lane, merges out of closed lanes and never blocks every lane.

**Weather.** From the second road on, each road's third level brings its weather instead of denser traffic, so each level still adds one thing (`world/hazards.ts`):

- sandstorms and fog shorten what the sensors can see,
- rain cuts grip,
- black ice gives almost none, and falling snow cuts sight a little,
- the night road is dark on every level: past the headlights, the side sensors see much less.

Grip is modelled simply: with less grip the car's direction of travel lags its heading, so it slides through turns, and it accelerates and brakes less.

Lane closures follow the weather too: snowdrifts on the snowy pass, flooding on the coast, sand drifts in the desert, and road works elsewhere.

**Themes:** the road moves through the original highway, a desert highway, a coast road, downtown at night (with headlights) and a snowy mountain pass, then mixes them. Road layouts are random for each session.

`npx tsx scripts/train.ts [generations] [cars] [mutation] [frame cap] [start level]` runs the highway headless and prints each generation's level, clears, cars passed and brain size. Two test runs with the same seeds took 1,600 and 2,050 seconds of training to clear level 9 with one layout per generation and no road-ahead input. With both changes, the same runs took 1,000 seconds or less. Level 7 took 46 to 59 generations instead of 76.

## Code map

```
src/
  neat.ts        NEAT: genomes, innovation numbers, speciation, crossover, growth
  network.ts     the course's fixed-shape network (kept for reference and tests)
  sensor.ts      ray casting against road edges and nearby traffic
  car.ts         physics, grip, collision, progress tracking, drawing
  road.ts        road shapes: lanes, curves, construction zones, cones, weather closures
  traffic.ts     seeded traffic: lane speeds, lane changes, merges
  themes.ts      highway themes, scenery and each theme's weather
  simulation.ts  levels, generations, NEAT breeding, saving
  chart.ts       learning curve
  visualizer.ts  draws the leader's network live
  main.ts        canvas, UI controls, session storage
  world/         hazards, scenery and the drawing helpers the roadside uses
scripts/train.ts headless trainer
tests/core.test.ts
```

## Design notes

The interface borrows from US highway signage. It uses Overpass (an open-source revival of Highway Gothic), green guide signs for the title and progress, real lane paint on the road, and construction orange reserved for the main action. In the network view, yellow connections excite a neuron and blue ones inhibit it.

## Credits and licences

- The course this started from is © Radu Mariescu-Istodor, MIT licence. See `COURSE-LICENSE.txt`.
- NEAT: Kenneth O. Stanley and Risto Miikkulainen, "Evolving Neural Networks through Augmenting Topologies", 2002.
