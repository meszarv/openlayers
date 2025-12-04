/**
 * @param {HTMLCanvasElement} canvas Canvas element.
 * @return {Promise<VexContext>} Vex context promise.
 */
// let promise =null;
// let layerChainPromise = Promise.resolve();
// export function createVexContext(canvas,repeated=0) {
//   console.log("createVexContext: looking for init...",{canvas,repeated});
//   if(window.initVexGPU){
//     console.log("createVexContext: initVexGpu exists");
//     if(layerChainPromise.isVex) return Promise.resolve(layerChainPromise);
//     return layerChainPromise.then(()=>{
//       console.log("createVexContext: layerChainPromise resolved");
//       layerChainPromise=window.initVexGPU(canvas,{interactive:false,workerScriptPath:'/vex/jswrapper/vex.worker.js'});
//       if(layerChainPromise.isVex) return Promise.resolve(layerChainPromise);
//       return layerChainPromise;
//     })
//   }else{
//     console.log("createVexContext: initVexGpu does not exist");
//     if(promise==null){
//         console.log("createVexContext: promise is null");
//         promise = new Promise((resolve,reject)=>{
//           console.log("createVexContext: promise");
//           // if(window.require && window.define && window.define.amd ){
//           //   const onloadPromise = 
//           //   window.require(['/vex/jswrapper/vex.js'],(mod)=>{
//           //     createVexContext(canvas).then((result)=>resolve(result));
//           //   });

import { resolve } from "path";

            
//           // }else{
//             const script = document.createElement('script');
//             script.src = '/vex/jswrapper/vex.js'
//             script.async = true;

//             script.onload = () =>{
//               console.log("createVexContext: vex loaded");
//               return createVexContext(canvas,repeated+1).then((result)=>{
//                 console.log("createVexContext: vex context created",result);
//                 resolve(result)
//               });
//             }
//             document.head.appendChild(script);
//           // }
          
          
//         })
//     }
//     return promise;
//   }
// }

let currentPromise = Promise.resolve();
// let promiseIsOccupied = false;
let vexScriptLoading = false;

export function createVexContext(canvas){
  console.log("createVexContext: trying to apply vex to ",canvas)
  if(window.initVexGPU){
    //initVexGPU is ready
    // promiseIsOccupied=true;
    return currentPromise = new Promise(resolve => {
      const vex = window.initVexGPU(canvas,{interactive:false,workerScriptPath:'/vex/jswrapper/vex.worker.js'});
      console.log("createVexContext: vex applied to ",canvas);
      resolve(vex);
    })
  } else {
    //initVexGPU is not yet loaded
    if(vexScriptLoading){
      return new Promise((resolve)=>{
        currentPromise.then(()=>{
          createVexContext(canvas).then((ctx)=>{
            resolve(ctx);
          });
        })
      })
    }
    
    vexScriptLoading = true;
    const promise = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = '/vex/jswrapper/vex.js'
      script.async = true;

      script.onload = () =>{
        resolve(createVexContext(canvas))
      }
      document.head.appendChild(script);
    });

    currentPromise = promise;

    return promise;
  }
}

export default createVexContext;
