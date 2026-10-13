# Quelle: Tutorial zum Auto-Reframe-Fix

Dieses Plugin setzt den Ablauf aus folgendem Video um:

- **Titel:** Pr Pro: Auto Reframe Sequence without Tracking
- **Autor:** Mathias Möhl (mamoworld)
- **URL:** https://www.youtube.com/watch?v=Fq0ogPX4ZMk
- **Transkript:** automatische englische Untertitel, hier bereinigt

## Der Algorithmus aus dem Video

Pro ausgewähltem Clip:

1. Auto-Reframe-Effekt in den Effektoptionen öffnen
2. **„Erzeugten Pfad überschreiben"** aktivieren
3. Zum gewünschten Referenz-Frame navigieren (Anfang, Mitte oder Ende des Clips)
4. **Alle Keyframes löschen**, dann **genau einen** Keyframe mit dem dortigen Wert setzen

Der entscheidende Satz, der hier mehrere Testrunden gekostet hat:

> „and make sure we also have a key frame [with] this value, because for whatever
> reason Premiere Pro wants to have at least one key frame on this property"

Eine frühere Fassung dieses Plugins schaltete Keyframing stattdessen ganz ab
(null Keyframes). Premiere überträgt den erzeugten Pfad dann erneut auf den
Parameter, und die Bewegung kehrt zurück. Siehe Commit
`aa34cd7` und den Abschnitt „Zwei Schreibmodi" in der README.

Hinweis: Das Video nutzt **Automation Blocks**, das Premiere auf UI-Ebene
steuert und dabei die effekteigene Logik mit auslöst. Dieses Plugin nutzt die
UXP-API, die Parameterwerte direkt schreibt und jene Logik umgeht — daher die
abweichenden Fallstricke, die in der README unter „Bekannte Einschränkungen"
dokumentiert sind.

## Transkript (bereinigt)

yeah hi everyone Gustavo asked here in the forums if you've got a sequence and this sequence is a 16 by9 for example and now you use Auto reframe to create for example a square version of it then he likes it that it right picks a part of the frame that makes sense you can see here it picks exactly it focuses on the woman yeah it picked the right Square part of this sequence uh but what he doesn't like is if you check here and you look here at the background really closely you can see that this background is moving a bit yeah and if you compare this with the original here the background is not moving at all because this was shot on a tripod so in other words it's nice that it identifies the subject and now by default it attempts to move with a subject if you you say yeah like you don't want it to move what can you do you can do the following you select the track and I show you first a manual approach and then how to do it automatically on many Clips with automation blocks for our Adobe Premier Pro 

so what do you do you select the clip and then you enable in the auto reframe which you find in the effect controls the override generated pass option this creates here a lot of key frames and this is the actual track and if you move here you can see that the x value is changing so this is exactly this track moving left to right that we want to eliminate so we can just pick a frame let's say we want to keep this one as is this Frame here and then you click here to delete all the key frames click on the stopwatch and then you need to click again to create just a single key frame at this position with this value and now you will see that the background is not moving anymore and that the track has been removed now what do you do if you want to do this on lots of Clips at once yeah so I can select these clips here for example and then you use my tool that I just created for you selected Clips remove auto reframe track and it does exactly the steps I've just shown on all selected Clips automatically and you can choose which frame you want to preserve the beginning of the clip the middle of the clip or the end of the clip let's choose end of the clip for example run the tool and if you now select any of these clips you can see that override generated path has been created and in this case a key frame has been added at the end of the clip here because we have chosen here end of the clip yeah this is all you need to do I put a download link for this tool here in the video description it's an XML file that you can download and then you can load it here into automation blocks or copy it in your user Library such that it shows up here in your list of custom tools if you want finally I want o quickly show you how you could create to quickly show you how you could create this tool yourself so let's quickly take a look at the code go here to this cript and maximize this window script and maximize this window here what this is doing it's creating a user interface the use position of this one here and it has the options beginning of clip middle of clip or end of clip so this is this dropdown and it saves it in this variable timing option and then it goes for each selected clip of all video tracks of the active sequence it does something and what does it do with them well everything that is tacked or plugged in here yeah what stacked or plugged in here yeah what does it do it first checks the timing option this is the variable we created here so this is either beginning of clip middle of clip or end of clip and if this timing option is beginning of the clip it sets a variable clip time to zero so this means creates a key frame at clip Time Zero um if the timing option is set to middle of clip it sets the clip time to the duration of the clip divided by two yeah this is exactly the middle of the clip half of the duration of the clip and otherwise it sets it to the end of the clip this is the time so all we've done here is etting a variable clip time to the time setting a variable clip time to the time where we later want to create our key frame 

and now we've got these three green blocks and you find all of them by the way here in the Premier Pro Murs and clip parameter section so you can add key frames or set properties of things in your um effect controls so everything you've got listed here can be set with it and remember again what we needed to do we first needed to enable this check boox then we needed to remove all those key frames here from adjust position and then we need to add those key single key frame again and that's exactly what what we do in these screen blocks here we set he checkbox so we set the clip the checkbox so we set the clip arameter override generated path to parameter override generated path to this to enabled or to true yeah of of the currently processed clip and then we select uh we set the adjust position this was the second so first we've set his checkbox and now we set the adjust his checkbox and now we set the adjust his checkbox and now we set the adjust position property here and to which value do we set well we set it to the value of this of the one key frame that we want to preserve yeah so we set the value to um the value we have of the same parameter at clip time at the time we set here yeah so this means either at the beginning of the clip at the middle of the clip or at the end of the clip so take the value at the beginning the middle or the end of the clip and set he value of this the value of this property to this value at all times effectively yeah and if the parameter has key frames this will be the case for us then these key frames should be deleted so here we delete all key frames and set the value to the value we had originally at the beginning middle or end of this property and then finally we need to create a key frame a single one and this is the third block again for the adjust position property of the clip we add uh key frame at clip time again this is the beginning the middle or the end of the um clip and what value should it have well the value we've just said before this value here yeah keeps the current value we have the proper value set already here here we just add a key frame or make sure we also have a key frame resist value because for whatever eason Premier Pro wants to have at reason Premier Pro wants to have at least one key frame on this property 

okay and that's really it it's just the same process I first showed manually executed in a tool on all selected Clips uch that you don't have to go through such that you don't have to go through them one by one manually I hope this tutorial was useful for you and solves your problem this is Matias from M world and I'm looking forward to see you in the next tutorial
