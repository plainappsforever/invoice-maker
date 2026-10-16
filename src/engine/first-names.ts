// Common given names (German, Austrian/Swiss, English, French, Italian, Dutch, Scandinavian, Polish, Turkish, Arabic),
// lower case without diacritics. Only a HINT for the contact-text parser (src/engine/contact-parse.ts): a two- or
// three-word line that starts with one of these is read as a person. Other signals (title, e-mail local part,
// "Inhaber:") work without it. PURE.
const NAMES = `
aaron abdul adam adrian ahmet ahmed aileen alan albert alessandro alex alexander alexandra alfred ali alice alina alexa
amelie amir ana andre andrea andreas andrew angela angelika anja anke ann anna anne annette anton antje antonia arne
arthur astrid ayse barbara bastian beate ben benedikt benjamin bernd bernhard berit bettina bianca birgit bjorn
boris brigitte bruno burak can carina carl carla carlo carlos carmen carolin caroline catherine charlotte chiara
chris christa christian christiane christina christine christoph christopher claire clara claudia claus clemens
cornelia daniel daniela david denis dennis diana dieter dirk dominik doris dorothea edith eduard elena eli elias
elif elisabeth elke ella ellen emil emilia emily emma emre enrico eric erik erika ernst esra eva fabian fatima
felix ferdinand filip finn florian francesca franz frank franziska frederik frieda friedrich fritz gabriele georg
george gerd gerhard gisela giulia giuseppe gregor gudrun guido gunter gustav hakan hanna hannah hannes hans harald
heike heiko heinrich heinz helen helena helga helmut hendrik henning henrik henry herbert hermann holger hugo ida
ines inga ingo ingrid irene iris isabel isabella jacob jakob james jan jana janina janine jannik jasmin jens jessica
jochen johann johanna johannes jonas jonathan jorg josef joseph julia julian juliane julius jurgen justin kai karin
karl karla karsten katarina katharina kathrin katja katrin kemal kerstin kevin kim klara klaus konrad kristina lara
lars laura lea lena leon leonie lina linda lisa lorenz lotte louis luca lucas lucia ludwig luis luisa lukas luke
maik maja malte manfred manuel manuela marc marcel marco marcus margarete maria marie marina mario marion mark
markus marlene martha martin martina mathias matteo matthias max maximilian mehmet melanie merve mia michael
michaela michelle mike milan mirjam moritz murat nadine nadja natalie nathalie nick nico nicole niklas nils nina
noah nora norbert olaf ole oliver olivia oskar otto pascal patricia patrick paul paula pauline peter petra philipp
pia pierre pieter rainer ralf ralph ramona rebecca regina reinhard renate rene reto richard robert robin roland
rolf roman ronja rosa ruth sabine sabrina sandra sara sarah sascha sebastian selin sergej silke simon simone sofia
sonja sophia sophie stefan stefanie steffen stephan stephanie susanne svea sven svenja sylvia tanja tatjana theo
theresa thomas thorsten tilo tim timo tina tobias tom torsten ulrich ulrike ursula ute uwe valentin vanessa vera
verena viktor viktoria walter werner wilhelm william wolfgang yasemin yusuf zeynep anette aylin baris deniz ebru
emine hatice huseyin ibrahim kadir mustafa omer ozlem serkan tugba volkan camille chloe claude jacques jean
julien laurent louise manon mathieu nicolas olivier philippe sylvie thierry valerie yves antonio davide elisa
federica francesco giorgio giovanni lorenzo marta paolo roberto sergio simona valentina daan femke joost lotte
ruud sanne willem bram anders astrid ingrid kasper lasse magnus sigrid agnieszka anna katarzyna krzysztof marek
piotr tomasz ewa olga dmitri ivan natalia elena fiona grace harry jack jake jane joe john kate lucy mary megan
nathan paul rachel ryan samuel sean sophie stephen steve susan victoria`;

export const FIRST_NAMES: ReadonlySet<string> = new Set(NAMES.split(/\s+/).filter(Boolean));

/** Lower case, diacritics folded (ü → u, ß → ss), for name and e-mail comparisons. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
